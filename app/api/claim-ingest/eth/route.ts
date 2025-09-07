// app/api/claim-ingest/eth/route.ts
// ETH claim-ingest (schema-aware with safe MINIMAL fallback)
// - Auth: x-cron-secret
// - Verify on-chain: receipt (confirmed) + tx (value/from/to) + block (timestamp)
// - Insert ONLY into columns that truly exist; if information_schema is unavailable, use MINIMAL fallback payload
// - Idempotent insert; optional wallet linking by to_address (if wallets table is readable)

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
function hexToNumber(hex: string): number {
  return Number(hexToBigInt(hex));
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
  if (!ETH_RPC_URL) return { ok: false as const, error: 'missing_eth_rpc_url' };
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
const fetchBlockByNumber = (bnHex: string) => rpcCall('eth_getBlockByNumber', [bnHex, false]);

// ---------- USD pricing via lib/fx.ts (optional, best-effort) ----------
async function priceEthToUsdOrNull(amountEthStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
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

// ---------- schema helpers ----------
type ColsInfo = { cols: Set<string>; fromInfoSchema: boolean };

async function getTableColumns(schema: string, table: string): Promise<ColsInfo> {
  const { data, error } = await supa()
    .from('information_schema.columns' as any)
    .select('column_name')
    .eq('table_schema', schema as any)
    .eq('table_name', table as any);

  if (!error && Array.isArray(data) && data.length) {
    return { cols: new Set((data as any[]).map((r) => r.column_name)), fromInfoSchema: true };
  }
  // MINIMAL fallback – samo ključna polja; NE uključuj asset/currency/symbol/network/source
  if (table === 'contributions') {
    return { cols: new Set(['tx_hash', 'amount', 'block_time', 'block_number', 'block_hash', 'from_address', 'to_address', 'status', 'fee', 'amount_usd', 'priced_at', 'wallet_id']), fromInfoSchema: false };
  }
  if (table === 'wallets') {
    return { cols: new Set(['id','wallet_id','address','addr','network','symbol','chain']), fromInfoSchema: false };
  }
  return { cols: new Set(), fromInfoSchema: false };
}

async function resolveWalletIdByAddress(toAddrLower: string): Promise<string | null> {
  const { cols: wcols } = await getTableColumns('public', 'wallets');
  const idCol = wcols.has('id') ? 'id' : (wcols.has('wallet_id') ? 'wallet_id' : null);
  const addrCol = wcols.has('address') ? 'address' : (wcols.has('addr') ? 'addr' : null);
  if (!idCol || !addrCol) return null;

  let q: any = supa().from('wallets').select(`${idCol}, ${addrCol}${wcols.has('network') ? ', network' : ''}${wcols.has('symbol') ? ', symbol' : ''}${wcols.has('chain') ? ', chain' : ''}`).limit(1);
  q = q.eq(addrCol, toAddrLower);
  if (wcols.has('network')) q = q.eq('network', 'ethereum');
  else if (wcols.has('chain')) q = q.in('chain', ['eth', 'ethereum']);
  else if (wcols.has('symbol')) q = q.in('symbol', ['ETH','eth']);

  let { data, error } = await q;
  if ((!data || !data.length) && !error) {
    let q2: any = supa().from('wallets').select(`${idCol}, ${addrCol}`).limit(1);
    q2 = q2.ilike(addrCol, toAddrLower);
    ({ data } = await q2);
  }
  if (!data || !data.length) return null;
  const row = data[0] as any;
  return String(row[idCol]) || null;
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
  if (!isValidEvmHash(tx)) return json(400, { ok: false, error: 'invalid_tx_format:expect_0x64_hex' });

  // 2) receipt
  const rcp = await fetchEthReceipt(tx);
  if (!rcp.ok) {
    if (rcp.error.includes('notFound')) return json(404, { ok: false, error: 'tx_not_found' });
    return json(502, { ok: false, error: rcp.error || 'rpc_error' });
  }
  const receipt = rcp.result;
  if (!receipt) return json(404, { ok: false, error: 'tx_not_found' });
  if (!receipt.blockNumber) return json(409, { ok: false, error: 'tx_pending' });

  // 3) tx + block
  const [txr, blkr] = await Promise.all([ fetchEthTx(tx), fetchBlockByNumber(receipt.blockNumber) ]);
  if (!txr.ok) return json(502, { ok: false, error: txr.error || 'rpc_error' });
  const txObj = txr.result;
  if (!txObj) return json(404, { ok: false, error: 'tx_not_found' });

  if (!blkr.ok) return json(502, { ok: false, error: blkr.error || 'rpc_error' });
  const blk = blkr.result;
  const tsSec = blk?.timestamp ? hexToNumber(String(blk.timestamp)) : null;
  const blockTimeISO = tsSec ? new Date(tsSec * 1000).toISOString() : null;

  const valueHex = txObj.value ?? '0x0';
  const amountEthStr = weiToEthString(String(valueHex));
  const toAddress = (txObj.to ? String(txObj.to) : '').toLowerCase();
  const fromAddress = (txObj.from ? String(txObj.from) : '').toLowerCase();
  const status = receipt.status === '0x1' ? 'success' : 'failed';

  // fee (optional)
  let feeEthStr: string | null = null;
  try {
    const gasUsed = receipt.gasUsed ? hexToBigInt(String(receipt.gasUsed)) : 0n;
    const effPrice = receipt.effectiveGasPrice ? hexToBigInt(String(receipt.effectiveGasPrice)) : 0n;
    const feeWei = gasUsed * effPrice;
    if (feeWei > 0) feeEthStr = weiToEthString('0x' + feeWei.toString(16));
  } catch {}

  // USD (best-effort)
  let amountUsd: number | null = null;
  let pricedAt: string | null = null;
  const priced = await priceEthToUsdOrNull(amountEthStr);
  if (priced) { amountUsd = priced.usd; pricedAt = priced.pricedAt; }

  try {
    // idempotent pre-check
    const { data: found, error: qErr } = await supa()
      .from('contributions')
      .select('id')
      .eq('tx_hash', tx)
      .limit(1);

    if (!qErr && found && found.length > 0) {
      return json(200, { ok: true, inserted: null, alreadyRecorded: true });
    }

    // detect columns
    const { cols, fromInfoSchema } = await getTableColumns('public', 'contributions');
    const payload: Record<string, any> = {};

    // always try to set these two (both in info_schema and minimal fallback)
    if (cols.has('tx_hash')) payload.tx_hash = tx;
    if (cols.has('amount'))  payload.amount  = amountEthStr;

    // block_time is often NOT NULL → fill if exists and we have timestamp
    if (blockTimeISO && cols.has('block_time')) payload.block_time = blockTimeISO;

    // Only if columns exist (and ONLY if we got them from info_schema or they are in minimal fallback)
    if (cols.has('block_number') && receipt.blockNumber) payload.block_number = hexToNumber(String(receipt.blockNumber));
    if (cols.has('block_hash') && receipt.blockHash) payload.block_hash = String(receipt.blockHash);
    if (cols.has('from_address') && fromAddress) payload.from_address = fromAddress;
    if (cols.has('to_address') && toAddress) payload.to_address = toAddress;
    if (cols.has('status')) payload.status = status;
    if (feeEthStr && cols.has('fee')) payload.fee = feeEthStr;

    if (amountUsd !== null && cols.has('amount_usd')) payload.amount_usd = amountUsd;
    if (pricedAt !== null && cols.has('priced_at')) payload.priced_at = pricedAt;

    // IMPORTANT: only set identity-ish fields if we REALLY saw them in information_schema
    if (fromInfoSchema) {
      if (cols.has('currency')) payload.currency = 'ETH';
      if (cols.has('symbol'))   payload.symbol   = 'ETH';
      if (cols.has('asset'))    payload.asset    = 'ETH';
      if (cols.has('network'))  payload.network  = 'ethereum';
      if (cols.has('source'))   payload.source   = 'claim';
    }

    // wallet mapping (best-effort)
    if (toAddress && cols.has('wallet_id')) {
      const walletId = await resolveWalletIdByAddress(toAddress);
      if (walletId) payload.wallet_id = walletId;
    }

    // safety
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

