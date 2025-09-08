// app/api/claim-ingest/trx/route.ts
// Tron (TRX) claim-ingest aligned to stable model (ETH/BTC/...)
// Scope: native TRX transfers (TransferContract). TRC-20 support can be added later.
// Tables:
//  - wallets: id, address, chain ('trx')
//  - contributions: wallet_id, tx_hash, amount, amount_usd, block_time, priced_at, note
//
// ENV used: TRX_RPC_URL, NOWNODES_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;

const CRON_SECRET = process.env.CRON_SECRET || '';
const TRX_RPC_URL = process.env.TRX_RPC_URL || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';

const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- utils ----------
const normalizeTxId = (s: string) => String(s || '').trim().toLowerCase();
const is64hex = (s: string) => /^[0-9a-fA-F]{64}$/.test(s);

// SUN -> TRX string (1 TRX = 1e6 SUN)
function sunToTrxString(sun: bigint | number | string): string {
  const bn = typeof sun === 'bigint' ? sun : BigInt(String(sun || '0'));
  const whole = bn / 1_000_000n;
  const frac  = bn % 1_000_000n;
  const rest = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return rest ? `${whole.toString()}.${rest}` : whole.toString();
}

// ---- Base58Check (Tron) hex (starts with 0x41...) -> base58 'T...' ----
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function sha256(bytes: Uint8Array): Uint8Array {
  // minimal sync SHA-256 via subtle is async; implement tiny JS sha256 is too big.
  // Use crypto.subtle (available in edge runtime). Wrap as sync-like with Atomics not allowed -> do async below.
  throw new Error('sha256_sync_unavailable');
}
async function sha256Async(bytes: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(buf);
}
function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const arr = new Uint8Array(h.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return arr;
}
function base58Encode(bytes: Uint8Array): string {
  let x = BigInt(0);
  for (const b of bytes) { x = (x << 8n) + BigInt(b); }
  let out = '';
  while (x > 0) {
    const mod = Number(x % 58n);
    out = B58_ALPHABET[mod] + out;
    x = x / 58n;
  }
  // leading zero bytes -> '1'
  let leading = 0;
  for (const b of bytes) { if (b === 0) leading++; else break; }
  return '1'.repeat(leading) + out;
}
async function tronHexToBase58(hex: string): Promise<string | null> {
  // Tron addresses in node JSON are hex with leading 0x41 (mainnet). Need Base58Check.
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^41[0-9a-fA-F]{40}$/.test(h)) return null;
  const payload = hexToBytes(h);
  const h1 = await sha256Async(payload);
  const h2 = await sha256Async(h1);
  const checksum = h2.slice(0, 4);
  const full = new Uint8Array(payload.length + 4);
  full.set(payload, 0);
  full.set(checksum, payload.length);
  return base58Encode(full);
}

// ---------- pricing ----------
async function priceToUsdOrNullTRX(amountStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter(k => typeof (fx as any)[k] === 'function');
    if (!fns.length) return null;
    const getPrices = (fx as any)[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['TRX']);
    const usd = prices?.TRX ?? prices?.trx;
    const amt = parseFloat(amountStr || '0');
    if (typeof usd !== 'number' || !Number.isFinite(amt)) return null;
    return { usd: +(amt * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// ---------- RPC (HTTP endpoints) ----------
async function post(path: string, payload: any): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (NOWNODES_API_KEY) { headers['api-key'] = NOWNODES_API_KEY; headers['x-api-key'] = NOWNODES_API_KEY; }
  const url = `${TRX_RPC_URL.replace(/\/+$/,'')}${path.startsWith('/') ? path : '/'+path}`;
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), cache: 'no-store' });
}

// gettransactionbyid: { value: <txid> }
async function getTxById(txid: string): Promise<any | null> {
  const res = await post('/wallet/gettransactionbyid', { value: txid });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j || !j.raw_data) return null;
  return j;
}

// gettransactioninfobyid: { value: <txid> } -> contains blockNumber, receipt
async function getTxInfoById(txid: string): Promise<any | null> {
  const res = await post('/wallet/gettransactioninfobyid', { value: txid });
  if (res.status === 404) return null;
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j) return null;
  return j;
}

// ---------- DB ----------
async function findTrxWalletId(addrBase58: string): Promise<string | null> {
  const { data } = await supa()
    .from('wallets')
    .select('id,address,chain')
    .eq('chain','trx')
    .eq('address', addrBase58)
    .limit(1);
  return data && data.length ? String(data[0].id) : null;
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok:false, code:'unauthorized', message:'Unauthorized.' });
  }
  if (!TRX_RPC_URL) {
    return json(502, { ok:false, code:'rpc_error', message:'TRX RPC URL is not configured.' });
  }

  // input (?tx= plus JSON body { txHash, note })
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  let txid = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  if (!txid) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });
  txid = normalizeTxId(txid);
  if (!is64hex(txid)) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });

  // idempotent pre-check
  {
    const { data: found } = await supa().from('contributions').select('id').eq('tx_hash', txid).limit(1);
    if (found && found.length) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash: txid } });
    }
  }

  // fetch tx + info
  const tx = await getTxById(txid);
  if (!tx) {
    return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash: txid } });
  }
  const info = await getTxInfoById(txid);
  if (!info || typeof info.blockNumber !== 'number' || !info.receipt || String(info.receipt.result).toUpperCase() !== 'SUCCESS') {
    return json(200, { ok:false, code:'rpc_error', message:'Transaction is not yet confirmed on-chain.', data:{ txHash: txid } });
  }

  // extract TransferContract
  const contracts: any[] = Array.isArray(tx?.raw_data?.contract) ? tx.raw_data.contract : [];
  const first = contracts.find(c => String(c?.type || '').includes('TransferContract'));
  if (!first) {
    // Not a native TRX transfer -> for baseline tretiramo kao "not our wallet"
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: txid } });
  }
  const val = first?.parameter?.value || {};
  const toHex = String(val?.to_address || '');
  const amountSun = val?.amount ?? 0;

  if (!toHex || !/^41[0-9a-fA-F]{40}$/.test(toHex)) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: txid } });
  }

  const toBase58 = await tronHexToBase58(toHex);
  if (!toBase58) {
    return json(502, { ok:false, code:'rpc_error', message:'Unable to decode destination address.' });
  }

  const wallet_id = await findTrxWalletId(toBase58);
  if (!wallet_id) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: txid } });
  }

  // block time
  const tsMs = Number(tx?.raw_data?.timestamp || 0);
  const blockTimeISO = Number.isFinite(tsMs) && tsMs > 0 ? new Date(tsMs).toISOString() : new Date().toISOString();

  // amount
  const amountStr = sunToTrxString(BigInt(String(amountSun || '0')));

  // pricing
  const priced = await priceToUsdOrNullTRX(amountStr);

  // insert
  const payload: Record<string, any> = {
    wallet_id,
    tx_hash: txid,
    amount: amountStr,
    block_time: blockTimeISO,
  };
  if (priced) { payload.amount_usd = priced.usd; payload.priced_at = priced.pricedAt; }
  if (note) payload.note = note;

  const { data: ins, error: insErr } = await supa().from('contributions').insert(payload).select('id').maybeSingle();
  if (insErr) {
    const msg = String(insErr.message || ''); const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash: txid } });
    }
    return json(400, { ok:false, code:'db_error', message:'Database write error.' });
  }

  return json(200, {
    ok: true,
    code: 'inserted',
    message: 'The transaction was successfully recorded on our project.',
    data: { txHash: txid, inserted: ins ?? null },
  });
}

