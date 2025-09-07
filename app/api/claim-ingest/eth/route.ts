// app/api/claim-ingest/eth/route.ts
// ETH claim-ingest (claim-first, schema-agnostic)
// - Auth: x-cron-secret
// - Verify on-chain (receipt + tx.value)
// - Insert contribution with required fields, but ONLY for columns that actually exist
//   (reads information_schema.columns for 'public.contributions')
// - Best-effort: amount_usd + priced_at via lib/fx.ts (if available)
// - Idempotent: SELECT -> INSERT; duplicate => alreadyRecorded:true

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Json = Record<string, unknown>;

const CRON_SECRET = process.env.CRON_SECRET || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';
const ETH_RPC_URL =
  process.env.ETH_RPC_URL ||
  process.env.EVM_RPC_URL ||
  'https://eth.nownodes.io';

function json(status: number, payload: Json) {
  return NextResponse.json(payload, { status });
}
function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- utils ----------
function normalizeEvm(tx: string) {
  const raw = tx.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return ('0x' + raw).toLowerCase();
  return raw;
}
function isValidEvmHash(tx: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(tx);
}
function hexToBigInt(hex: string): bigint {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + (clean || '0'));
}
function weiToEthString(weiHexOrDec: string): string {
  const wei = weiHexOrDec.startsWith('0x') ? hexToBigInt(weiHexOrDec) : BigInt(weiHexOrDec);
  const ether = wei / 10n ** 18n;
  const remainder = wei % 10n ** 18n;
  const remainderStr = remainder.toString().padStart(18, '0').replace(/0+$/, '');
  return remainderStr ? `${ether.toString()}.${remainderStr}` : ether.toString();
}

// ---------- RPC ----------
async function rpcCall(method: string, params: any[]) {
  if (!ETH_RPC_URL) return { ok: false, error: 'missing_eth_rpc_url' as const };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (NOWNODES_API_KEY) {
      headers['api-key'] = NOWNODES_API_KEY;
      headers['x-api-key'] = NOWNODES_API_KEY;
    }
    const res = await fetch(ETH_RPC_URL, { method: 'POST', headers, body });
    const txt = await res.text();
    let j: any = null;
    try { j = txt ? JSON.parse(txt) : null; } catch { /* pass */ }
    if (!res.ok) return { ok: false as const, error: `rpc_http_${res.status}:${txt || 'no_body'}` };
    if (j?.error) return { ok: false as const, error: `rpc_${j.error?.code}:${j.error?.message}` };
    return { ok: true as const, result: j?.result };
  } catch (e: any) {
    return { ok: false as const, error: `rpc_network:${e?.message || 'unknown'}` };
  }
}
const fetchEthReceipt = (h: string) => rpcCall('eth_getTransactionReceipt', [h]);
const fetchEthTx = (h: string) => rpcCall('eth_getTransactionByHash', [h]);

// ---------- optional USD pricing via lib/fx.ts ----------
async function priceEthToUsdOrNull(amountEthStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx'); // your module
    const fns = ['getUsdPrices', 'fetchUsdPrices', 'getPrices', 'pricesForSymbols'].filter(
      (k) => typeof fx[k] === 'function'
    );
    if (fns.length === 0) return null;
    const getPrices = fx[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['ETH']);
    const usdPrice = prices?.ETH ?? prices?.eth ?? null;
    if (typeof usdPrice !== 'number') return null;
    const eth = parseFloat(amountEthStr || '0');
    if (!Number.isFinite(eth)) return null;
    return { usd: +(eth * usdPrice).toFixed(2), pricedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

// ---------- schema-aware helpers ----------
async function getContributionColumns(): Promise<Set<string>> {
  // Read available columns for public.contributions so we only write what exists.
  const { data, error } = await supa().rpc('exec_sql', {
    sql: `
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'contributions'
    `,
  } as any);
  // If you don't have a helper function exec_sql installed, fall back to a regular select (works with service role):
  if (error || !Array.isArray(data)) {
    const { data: cols, error: e2 } = await supa()
      .from('information_schema.columns' as any)
      .select('column_name')
      .eq('table_schema', 'public' as any)
      .eq('table_name', 'contributions' as any);
    if (!e2 && Array.isArray(cols)) return new Set(cols.map((r: any) => r.column_name));
    // Worst-case: assume minimal columns
    return new Set(['tx_hash', 'amount']);
  }
  return new Set((data as any[]).map((r) => r.column_name));
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // 0) auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  // 1) input
  const url = new URL(req.url);
  let tx = (url.searchParams.get('tx') || '').trim();
  if (!tx) return json(400, { ok: false, error: 'missing_tx' });
  tx = normalizeEvm(tx);
  if (!isValidEvmHash(tx)) {
    return json(400, { ok: false, error: 'invalid_tx_format:expect_0x64_hex' });
  }

  // 2) on-chain confirm
  const rcp = await fetchEthReceipt(tx);
  if (!rcp.ok) {
    if (rcp.error.includes('notFound')) return json(404, { ok: false, error: 'tx_not_found' });
    return json(502, { ok: false, error: rcp.error || 'rpc_error' });
  }
  const receipt = rcp.result;
  if (!receipt) return json(404, { ok: false, error: 'tx_not_found' });
  if (!receipt.blockNumber) return json(409, { ok: false, error: 'tx_pending' });

  // 3) fetch tx (value)
  const txr = await fetchEthTx(tx);
  if (!txr.ok) return json(502, { ok: false, error: txr.error || 'rpc_error' });
  const txObj = txr.result;
  if (!txObj) return json(404, { ok: false, error: 'tx_not_found' });
  const valueHex = txObj.value ?? '0x0';
  const amountEthStr = weiToEthString(String(valueHex));

  // 4) optional USD pricing
  let amountUsd: number | null = null;
  let pricedAt: string | null = null;
  const priced = await priceEthToUsdOrNull(amountEthStr);
  if (priced) {
    amountUsd = priced.usd;
    pricedAt = priced.pricedAt;
  }

  // 5) idempotent write; only include columns that exist
  try {
    // 5a) pre-check exact match
    const { data: found, error: qErr } = await supa()
      .from('contributions')
      .select('id')
      .eq('tx_hash', tx)
      .limit(1);

    if (!qErr && found && found.length > 0) {
      return json(200, { ok: true, inserted: null, alreadyRecorded: true });
    }

    // 5b) build payload by schema
    const cols = await getContributionColumns();
    const payload: Record<string, any> = {};

    // mandatory we rely on:
    if (cols.has('tx_hash')) payload.tx_hash = tx;
    if (cols.has('amount')) payload.amount = amountEthStr;

    // optional columns if present:
    if (amountUsd !== null && cols.has('amount_usd')) payload.amount_usd = amountUsd;
    if (pricedAt !== null && cols.has('priced_at')) payload.priced_at = pricedAt;

    // common optional columns if they exist in your schema:
    if (cols.has('currency')) payload.currency = 'ETH';
    if (cols.has('symbol')) payload.symbol = 'ETH';
    if (cols.has('asset')) payload.asset = 'ETH';
    if (cols.has('chain')) payload.chain = 'eth';
    if (cols.has('network')) payload.network = 'ethereum';
    if (cols.has('source')) payload.source = 'claim'; // helpful provenance flag

    // Safety: ensure we at least set tx_hash + amount
    if (!('tx_hash' in payload) || !('amount' in payload)) {
      return json(500, { ok: false, error: 'server_misconfigured_missing_columns(tx_hash/amount)' });
    }

    const { data: ins, error: insErr } = await supa()
      .from('contributions')
      .insert(payload)
      .select('id')
      .maybeSingle();

    if (insErr) {
      const msg = String(insErr.message || '');
      const code = (insErr as any).code || '';
      if (code === '23505' || /duplicate key|unique/i.test(msg)) {
        return json(200, { ok: true, inserted: null, alreadyRecorded: true });
      }
      return json(400, { ok: false, error: msg || 'db_error' });
    }

    return json(200, { ok: true, inserted: ins ?? null, alreadyRecorded: false });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || 'db_exception' });
  }
}

