// app/api/claim-ingest/xrp/route.ts
// XRPL claim-ingest (Payment) aligned to stable model
// Response: { ok, code, message, data? }
// Tables:
//  - wallets(chain='xrp', address = classic XRP address, e.g. "r...")
//  - contributions(wallet_id, tx_hash, amount, amount_usd, block_time, priced_at, note)

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;
type RpcOk<T=any> = { ok: true; result: T };
type RpcErr = { ok: false; error: string };

const CRON_SECRET = process.env.CRON_SECRET || '';
const XRP_RPC_URL = process.env.XRP_RPC_URL || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';

const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- utils ----------
const normalizeTxHash64hex = (s: string) => String(s || '').trim();
const is64hex = (s: string) => /^[0-9A-Fa-f]{64}$/.test(s);

// XRPL "date" is Ripple epoch (seconds since 2000-01-01T00:00:00Z). Convert to ISO.
function rippleEpochToISO(rippleSec: number): string {
  const UNIX_EPOCH_DIFF = 946684800; // seconds between 1970 and 2000
  const unixSec = rippleSec + UNIX_EPOCH_DIFF;
  return new Date(unixSec * 1000).toISOString();
}

// best-effort pricing via fx (XRP)
async function priceToUsdOrNullXRP(amountStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter(k => typeof (fx as any)[k] === 'function');
    if (!fns.length) return null;
    const getPrices = (fx as any)[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['XRP']);
    const usd = prices?.XRP ?? prices?.xrp;
    const amt = parseFloat(amountStr || '0');
    if (typeof usd !== 'number' || !Number.isFinite(amt)) return null;
    return { usd: +(amt * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// ---------- rpc ----------
async function rpc(method: string, params: any): Promise<RpcOk | RpcErr> {
  if (!XRP_RPC_URL) return { ok: false, error: 'missing_xrp_rpc_url' };
  const body = JSON.stringify({ method, params });
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (NOWNODES_API_KEY) { headers['api-key'] = NOWNODES_API_KEY; headers['x-api-key'] = NOWNODES_API_KEY; }
    const res = await fetch(XRP_RPC_URL, { method: 'POST', headers, body, cache: 'no-store' });
    const txt = await res.text();
    let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!res.ok) return { ok: false, error: `rpc_http_${res.status}:${txt || 'no_body'}` };
    if (j?.result?.error) return { ok: false, error: `rpc_${j.result.error}:${j.result.error_message || ''}` };
    return { ok: true, result: j?.result };
  } catch (e: any) {
    return { ok: false, error: `rpc_network:${e?.message || 'unknown'}` };
  }
}

// ---------- db ----------
async function findXrpWalletId(addr: string): Promise<string | null> {
  const { data } = await supa()
    .from('wallets')
    .select('id,address,chain')
    .eq('chain','xrp')
    .eq('address', addr)
    .limit(1);
  return data && data.length ? String(data[0].id) : null;
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) return json(401, { ok:false, code:'unauthorized', message:'Unauthorized.' });

  // input
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  let tx = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  if (!tx) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });
  tx = normalizeTxHash64hex(tx);
  if (!is64hex(tx)) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });

  // idempotent pre-check
  {
    const { data: found } = await supa().from('contributions').select('id').eq('tx_hash', tx).limit(1);
    if (found && found.length) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash: tx } });
    }
  }

  // fetch tx
  const r = await rpc('tx', { transaction: tx, binary: false });
  if (!r.ok) {
    // XRPL returns specific error if not found (e.g., "txnNotFound")
    if (/txnNotFound/i.test(r.error || '')) {
      return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash: tx } });
    }
    return json(502, { ok:false, code:'rpc_error', message:'An error occurred while fetching the transaction.' });
  }
  const res: any = r.result || {};
  // Validated?
  const validated: boolean = !!res.validated;
  if (!validated) {
    return json(200, { ok:false, code:'rpc_error', message:'Transaction is not yet confirmed on-chain.', data:{ txHash: tx } });
  }

  // Extract destination + amount (drops -> XRP)
  const txObj = res.tx || res; // some nodes place fields at top-level
  const dest = String(txObj?.Destination || '').trim();
  const amountDrops = txObj?.Amount;
  // Amount can be string (drops) or object (issued currency). We only accept native XRP.
  const isNative = typeof amountDrops === 'string';
  const amountXrpStr = isNative ? (() => {
    const drops = BigInt(amountDrops);
    const whole = drops / 1_000_000n;
    const frac = drops % 1_000_000n;
    const rest = frac.toString().padStart(6, '0').replace(/0+$/, '');
    return rest ? `${whole.toString()}.${rest}` : whole.toString();
  })() : '0';

  if (!dest) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: tx } });
  }

  const wallet_id = await findXrpWalletId(dest);
  if (!wallet_id) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: tx } });
  }

  // block time (Ripple epoch seconds at res.date)
  const blockTimeISO = typeof res.date === 'number' ? rippleEpochToISO(res.date) : new Date().toISOString();

  // pricing
  const priced = await priceToUsdOrNullXRP(amountXrpStr);

  // insert
  const payload: Record<string, any> = {
    wallet_id,
    tx_hash: tx,
    amount: amountXrpStr,
    block_time: blockTimeISO,
  };
  if (priced) { payload.amount_usd = priced.usd; payload.priced_at = priced.pricedAt; }
  if (note) payload.note = note;

  const { data: ins, error: insErr } = await supa().from('contributions').insert(payload).select('id').maybeSingle();
  if (insErr) {
    const msg = String(insErr.message || ''); const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash: tx } });
    }
    return json(400, { ok:false, code:'db_error', message:'Database write error.' });
  }

  return json(200, { ok:true, code:'inserted', message:'The transaction was successfully recorded on our project.', data:{ txHash: tx, inserted: ins ?? null } });
}

