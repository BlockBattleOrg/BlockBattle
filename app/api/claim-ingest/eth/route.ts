// app/api/claim-ingest/eth/route.ts
// ETH claim-ingest (claim-first)
// - Auth: x-cron-secret
// - Verify on-chain (receipt + tx.value)
// - Insert contribution with amount (ETH), currency='ETH', chain='eth'
// - Best-effort: set amount_usd + priced_at using lib/fx.ts (if available)
// - Idempotent: SELECT -> INSERT; duplicate => alreadyRecorded:true
// - No dependency on DB unique constraints

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Json = Record<string, unknown>;

// ------------ env / config ------------
const CRON_SECRET = process.env.CRON_SECRET || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';
const ETH_RPC_URL =
  process.env.ETH_RPC_URL ||
  process.env.EVM_RPC_URL ||
  'https://eth.nownodes.io';

// ------------ helpers ------------
function json(status: number, payload: Json) {
  return NextResponse.json(payload, { status });
}
function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

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

// --- RPC base ---
async function rpcCall(method: string, params: any[]): Promise<{ ok: true; result: any } | { ok: false; error: string }> {
  if (!ETH_RPC_URL) return { ok: false, error: 'missing_eth_rpc_url' };
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
    if (!res.ok) return { ok: false, error: `rpc_http_${res.status}:${txt || 'no_body'}` };
    if (j?.error) return { ok: false, error: `rpc_${j.error?.code}:${j.error?.message}` };
    return { ok: true, result: j?.result };
  } catch (e: any) {
    return { ok: false, error: `rpc_network:${e?.message || 'unknown'}` };
  }
}
const fetchEthReceipt = (h: string) => rpcCall('eth_getTransactionReceipt', [h]);
const fetchEthTx = (h: string) => rpcCall('eth_getTransactionByHash', [h]);

// --- optional: use lib/fx.ts for USD pricing ---
async function priceEthToUsdOrNull(amountEthStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    // dynamic import to avoid hard dependency on exact export names
    const fx: any = await import('@/lib/fx');

    // find a price getter function
    const candidateFns = [
      'getUsdPrices',       // (symbols: string[]) => Promise<Record<string, number>>
      'fetchUsdPrices',
      'getPrices',
      'pricesForSymbols',
    ].filter((k) => typeof fx[k] === 'function');

    if (candidateFns.length === 0) return null;

    const getPrices = fx[candidateFns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['ETH']);
    const usdPrice = prices?.ETH ?? prices?.eth ?? null;
    if (typeof usdPrice !== 'number') return null;

    const eth = parseFloat(amountEthStr || '0');
    if (!Number.isFinite(eth)) return null;

    const usd = +(eth * usdPrice).toFixed(2);
    const pricedAt = new Date().toISOString();
    return { usd, pricedAt };
  } catch {
    return null;
  }
}

// ------------ handler ------------
export async function POST(req: NextRequest) {
  // 0) auth guard
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

  // 2) on-chain verification: must be confirmed
  const rcp = await fetchEthReceipt(tx);
  if (!rcp.ok) {
    if (rcp.error.includes('notFound')) return json(404, { ok: false, error: 'tx_not_found' });
    return json(502, { ok: false, error: rcp.error || 'rpc_error' });
  }
  const receipt = rcp.result;
  if (!receipt) return json(404, { ok: false, error: 'tx_not_found' });
  if (!receipt.blockNumber) return json(409, { ok: false, error: 'tx_pending' });

  // 3) fetch tx for value (wei)
  const txr = await fetchEthTx(tx);
  if (!txr.ok) return json(502, { ok: false, error: txr.error || 'rpc_error' });
  const txObj = txr.result;
  if (!txObj) return json(404, { ok: false, error: 'tx_not_found' });

  const valueHex = txObj.value ?? '0x0';
  const amountEthStr = weiToEthString(String(valueHex)); // e.g. "0.1234"

  // 4) compute USD best-effort via lib/fx (optional)
  let amountUsd: number | null = null;
  let pricedAt: string | null = null;
  const priced = await priceEthToUsdOrNull(amountEthStr);
  if (priced) {
    amountUsd = priced.usd;
    pricedAt = priced.pricedAt;
  }

  // 5) idempotent write (no ON CONFLICT) – ensure required NOT NULLs are set
  try {
    // 5a) exact pre-check
    const { data: found, error: qErr } = await supa()
      .from('contributions')
      .select('id')
      .eq('tx_hash', tx)
      .limit(1);

    if (!qErr && found && found.length > 0) {
      return json(200, { ok: true, inserted: null, alreadyRecorded: true });
    }

    // 5b) insert payload – adjust keys if your schema differs
    const payload: Record<string, any> = {
      tx_hash: tx,
      chain: 'eth',          // if column exists
      currency: 'ETH',       // if column exists
      amount: amountEthStr,  // <- satisfies NOT NULL amount
    };
    if (amountUsd !== null) payload.amount_usd = amountUsd;
    if (pricedAt !== null) payload.priced_at = pricedAt;

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

