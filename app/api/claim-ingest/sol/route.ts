// app/api/claim-ingest/sol/route.ts
// Solana claim-ingest using getTransaction (finalized, jsonParsed)
// Logic: find positive balance delta on any of our SOL wallet addresses (lamports -> SOL)

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;
type RpcOk<T=any> = { ok: true; result: T };
type RpcErr = { ok: false; error: string };

const CRON_SECRET = process.env.CRON_SECRET || '';
const SOL_RPC_URL = process.env.SOL_RPC_URL || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';

const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// base58 (simplified) – accept typical Solana signature charset
const isBase58 = (s: string) => /^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(s);

// pricing (SOL)
async function priceToUsdOrNullSOL(amountStr: string): Promise<{ usd:number; pricedAt:string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter(k => typeof (fx as any)[k] === 'function');
    if (!fns.length) return null;
    const getPrices = (fx as any)[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['SOL']);
    const usd = prices?.SOL ?? prices?.sol;
    const amt = parseFloat(amountStr || '0');
    if (typeof usd !== 'number' || !Number.isFinite(amt)) return null;
    return { usd: +(amt * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// rpc
async function rpc(method: string, params: any[]): Promise<RpcOk | RpcErr> {
  if (!SOL_RPC_URL) return { ok: false, error: 'missing_sol_rpc_url' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (NOWNODES_API_KEY) { headers['api-key'] = NOWNODES_API_KEY; headers['x-api-key'] = NOWNODES_API_KEY; }
    const res = await fetch(SOL_RPC_URL, { method: 'POST', headers, body, cache: 'no-store' });
    const txt = await res.text();
    let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!res.ok) return { ok: false, error: `rpc_http_${res.status}:${txt || 'no_body'}` };
    if (j?.error) return { ok: false, error: `rpc_${j.error?.code}:${j.error?.message}` };
    return { ok: true, result: j?.result };
  } catch (e: any) {
    return { ok: false, error: `rpc_network:${e?.message || 'unknown'}` };
  }
}

// db
async function getSolWalletIds(): Promise<Record<string, string>> {
  const { data } = await supa().from('wallets').select('id,address,chain').eq('chain','sol');
  const map: Record<string,string> = {};
  if (Array.isArray(data)) for (const w of data) if (w?.address) map[String(w.address)] = String(w.id);
  return map;
}

export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) return json(401, { ok:false, code:'unauthorized', message:'Unauthorized.' });

  // input
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  let sig = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  if (!sig) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });
  if (!isBase58(sig)) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });

  // idempotent
  {
    const { data: found } = await supa().from('contributions').select('id').eq('tx_hash', sig).limit(1);
    if (found && found.length) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash: sig } });
    }
  }

  // fetch tx (finalized)
  const r = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0 }]);
  if (!r.ok) {
    return json(502, { ok:false, code:'rpc_error', message:'An error occurred while fetching the transaction.' });
  }
  if (!r.result) {
    return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash: sig } });
  }

  const tx: any = r.result;
  if (tx?.meta?.err) {
    return json(200, { ok:false, code:'rpc_error', message:'Transaction is not yet confirmed on-chain.', data:{ txHash: sig } });
  }

  const accountKeys: string[] = (tx?.transaction?.message?.accountKeys || []).map((k: any) => (typeof k === 'string' ? k : k?.pubkey)).filter(Boolean);
  const pre: number[] = Array.isArray(tx?.meta?.preBalances) ? tx.meta.preBalances : [];
  const post: number[] = Array.isArray(tx?.meta?.postBalances) ? tx.meta.postBalances : [];
  const blockTimeISO = typeof tx?.blockTime === 'number' ? new Date(tx.blockTime * 1000).toISOString() : new Date().toISOString();

  const addrToWalletId = await getSolWalletIds();
  const ourAddrs = Object.keys(addrToWalletId);
  if (!ourAddrs.length) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: sig } });
  }

  let lamportsGain = 0n;
  let chosenWalletId: string | null = null;

  for (let i = 0; i < accountKeys.length; i++) {
    const addr = accountKeys[i];
    if (!addrToWalletId[addr]) continue;
    const preLam = BigInt(String(pre[i] ?? 0));
    const postLam = BigInt(String(post[i] ?? 0));
    const delta = postLam - preLam;
    if (delta > 0n) {
      lamportsGain += delta;
      if (!chosenWalletId) chosenWalletId = addrToWalletId[addr];
    }
  }

  if (lamportsGain <= 0n || !chosenWalletId) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: sig } });
  }

  // lamports -> SOL (1 SOL = 1e9 lamports)
  const whole = lamportsGain / 1_000_000_000n;
  const frac = lamportsGain % 1_000_000_000n;
  const rest = frac.toString().padStart(9, '0').replace(/0+$/, '');
  const amountStr = rest ? `${whole.toString()}.${rest}` : whole.toString();

  const priced = await priceToUsdOrNullSOL(amountStr);

  const payload: Record<string, any> = {
    wallet_id: chosenWalletId,
    tx_hash: sig,
    amount: amountStr,
    block_time: blockTimeISO,
  };
  if (priced) { payload.amount_usd = priced.usd; payload.priced_at = priced.pricedAt; }
  if (note) payload.note = note;

  const { data: ins, error: insErr } = await supa().from('contributions').insert(payload).select('id').maybeSingle();
  if (insErr) {
    const msg = String(insErr.message || ''); const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash: sig } });
    }
    return json(400, { ok:false, code:'db_error', message:'Database write error.' });
  }

  return json(200, { ok:true, code:'inserted', message:'The transaction was successfully recorded on our project.', data:{ txHash: sig, inserted: ins ?? null } });
}

