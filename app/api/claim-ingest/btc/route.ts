// app/api/claim-ingest/btc/route.ts
// Bitcoin claim-ingest aligned to stable ETH model (same response contract)
// Tables:
// - contributions: wallet_id, tx_hash, amount, amount_usd, block_time, priced_at, note
// - wallets: id, address, chain
// Mapping: find any vout whose scriptpubkey_address equals a wallet in wallets where chain='btc'
// Amount: sum of ALL outputs in this tx that go to our BTC wallet(s), in BTC (string)
// Pricing: best-effort via lib/fx (BTC)
// Idempotent: skip if tx_hash already exists
// Response schema: { ok, code, message, data? }

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;

const CRON_SECRET = process.env.CRON_SECRET || '';
const BTC_API_BASE = process.env.BTC_API_BASE || ''; // e.g. https://mempool.space/api

function json(status: number, payload: J) {
  return NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}
function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- utils ----------
const normalizeTxId = (tx: string) => String(tx || '').trim().toLowerCase();
const isTxId64Hex = (tx: string) => /^[0-9a-fA-F]{64}$/.test(tx);

// Accept bigint too (fixes TS error when summing satoshis as BigInt)
function satsToBtcString(sats: bigint | number | string): string {
  const s = typeof sats === 'bigint' ? sats : BigInt(String(sats));
  const whole = s / 100_000_000n;
  const frac = s % 100_000_000n;
  const rest = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return rest ? `${whole.toString()}.${rest}` : whole.toString();
}

// ---------- pricing ----------
async function priceBtcToUsdOrNull(amountBtcStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices', 'fetchUsdPrices', 'getPrices', 'pricesForSymbols'].filter(k => typeof (fx as any)[k] === 'function');
    if (!fns.length) return null;
    const getPrices = (fx as any)[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['BTC']);
    const usd = prices?.BTC ?? prices?.btc;
    if (typeof usd !== 'number') return null;
    const btc = parseFloat(amountBtcStr || '0');
    if (!Number.isFinite(btc)) return null;
    return { usd: +(btc * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// ---------- DB helpers ----------
async function findBtcWalletIdsByAddresses(addrs: string[]): Promise<Record<string, string>> {
  // returns map address -> wallet_id for known BTC wallets
  if (!addrs.length) return {};
  const { data, error } = await supa()
    .from('wallets')
    .select('id,address,chain')
    .eq('chain', 'btc')
    .in('address', addrs);
  if (error || !data) return {};
  const map: Record<string, string> = {};
  for (const w of data) {
    if (w?.address) map[String(w.address)] = String(w.id);
  }
  return map;
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok: false, code: 'unauthorized', message: 'Unauthorized.' });
  }

  // input (?tx= and/or JSON body { txHash, note })
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  let txid = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  if (!txid) {
    return json(400, { ok: false, code: 'invalid_payload', message: 'Invalid transaction hash format.' });
  }
  txid = normalizeTxId(txid);
  if (!isTxId64Hex(txid)) {
    return json(400, { ok: false, code: 'invalid_payload', message: 'Invalid transaction hash format.' });
  }

  if (!BTC_API_BASE) {
    return json(502, { ok: false, code: 'rpc_error', message: 'BTC API base URL is not configured.' });
  }

  // idempotent pre-check
  {
    const { data: found, error: qErr } = await supa().from('contributions').select('id').eq('tx_hash', txid).limit(1);
    if (!qErr && found && found.length) {
      return json(200, { ok: true, code: 'duplicate', message: 'The transaction has already been recorded in our project before.', data: { txHash: txid } });
    }
  }

  // fetch tx and status from mempool.space (Esplora-compatible)
  let txRes: Response | null = null;
  let statusRes: Response | null = null;
  try {
    txRes = await fetch(`${BTC_API_BASE}/tx/${txid}`, { cache: 'no-store' });
    statusRes = await fetch(`${BTC_API_BASE}/tx/${txid}/status`, { cache: 'no-store' });
  } catch (e: any) {
    return json(502, { ok: false, code: 'rpc_error', message: 'An error occurred while fetching the transaction.' });
  }

  if (!txRes?.ok) {
    // 404 on mempool.space means tx not known
    return json(200, { ok: false, code: 'tx_not_found', message: 'The hash of this transaction does not exist on the blockchain.', data: { txHash: txid } });
  }

  const txJson = await txRes.json().catch(() => null as any);
  const statusJson = statusRes && statusRes.ok ? await statusRes.json().catch(() => null as any) : null;

  if (!txJson || typeof txJson !== 'object') {
    return json(200, { ok: false, code: 'tx_not_found', message: 'The hash of this transaction does not exist on the blockchain.', data: { txHash: txid } });
  }

  // status: { confirmed:boolean, block_time:number, block_height:number? }
  const confirmed = Boolean(statusJson?.confirmed);
  const blockTimeSec = confirmed ? Number(statusJson?.block_time || 0) : 0;

  if (!confirmed) {
    return json(200, { ok: false, code: 'rpc_error', message: 'Transaction is not yet confirmed on-chain.', data: { txHash: txid } });
  }
  if (!blockTimeSec || !Number.isFinite(blockTimeSec)) {
    return json(502, { ok: false, code: 'rpc_error', message: 'Unable to fetch block information.' });
  }
  const blockTimeISO = new Date(blockTimeSec * 1000).toISOString();

  // txJson.vout: [{ value: number (sats), scriptpubkey_address?: string, ... }, ...]
  const vout: any[] = Array.isArray(txJson?.vout) ? txJson.vout : [];
  const allOutAddrs = vout.map((o) => String(o?.scriptpubkey_address || '')).filter(Boolean);

  if (!allOutAddrs.length) {
    return json(200, { ok: false, code: 'not_project_wallet', message: 'The transaction is not directed to our project. The wallet address does not belong to this project.', data: { txHash: txid } });
  }

  const addrToWalletId = await findBtcWalletIdsByAddresses(allOutAddrs);
  const ourAddrs = Object.keys(addrToWalletId);
  if (!ourAddrs.length) {
    // No output belongs to our project wallets
    return json(200, { ok: false, code: 'not_project_wallet', message: 'The transaction is not directed to our project. The wallet address does not belong to this project.', data: { txHash: txid } });
  }

  // Sum all outputs that go to any of our BTC addresses
  let satsSum = 0n;
  let chosenWalletId: string | null = null;

  for (const o of vout) {
    const addr = String(o?.scriptpubkey_address || '');
    if (addr && addrToWalletId[addr]) {
      const valSats = BigInt(String(o?.value ?? '0')); // mempool.space returns value in sats
      satsSum += valSats;
      // pick first matched wallet_id as "owner" of the contribution row
      if (!chosenWalletId) chosenWalletId = addrToWalletId[addr];
    }
  }

  if (satsSum <= 0n || !chosenWalletId) {
    return json(200, { ok: false, code: 'not_project_wallet', message: 'The transaction is not directed to our project. The wallet address does not belong to this project.', data: { txHash: txid } });
  }

  const amountBtcStr = satsToBtcString(satsSum);

  // best-effort pricing
  const priced = await priceBtcToUsdOrNull(amountBtcStr);

  // payload
  const payload: Record<string, any> = {
    wallet_id: chosenWalletId,
    tx_hash: txid,
    amount: amountBtcStr,
    block_time: blockTimeISO,
  };
  if (priced) { payload.amount_usd = priced.usd; payload.priced_at = priced.pricedAt; }
  if (note) payload.note = note;

  // insert
  const { data: ins, error: insErr } = await supa().from('contributions').insert(payload).select('id').maybeSingle();
  if (insErr) {
    const msg = String(insErr.message || ''); const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json(200, { ok: true, code: 'duplicate', message: 'The transaction has already been recorded in our project before.', data: { txHash: txid } });
    }
    return json(400, { ok: false, code: 'db_error', message: 'Database write error.' });
  }

  return json(200, {
    ok: true,
    code: 'inserted',
    message: 'The transaction was successfully recorded on our project.',
    data: { txHash: txid, inserted: ins ?? null },
  });
}

