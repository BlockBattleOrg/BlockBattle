// app/api/claim-ingest/doge/route.ts
// Dogecoin claim-ingest aligned to stable BTC/ETH model (same response contract)
//
// Tables:
// - contributions: wallet_id, tx_hash, amount, amount_usd, block_time, priced_at, note
// - wallets: id, address, chain
// Mapping: sum vout.value for outputs whose address matches wallets.address where chain='doge'
// Pricing: best-effort via lib/fx (symbol: 'DOGE')
// Idempotent on tx_hash
//
// ENV used: DOGE_RPC_URL, NOWNODES_API_KEY, SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, CRON_SECRET

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;
type RpcOk<T=any> = { ok: true; result: T };
type RpcErr = { ok: false; error: string };

const CRON_SECRET = process.env.CRON_SECRET || '';
const DOGE_RPC_URL = process.env.DOGE_RPC_URL || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';

const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// -------- utils --------
const normalizeTxId = (tx: string) => String(tx || '').trim().toLowerCase();
const isTxId64Hex = (tx: string) => /^[0-9a-fA-F]{64}$/.test(tx);

function sum(a: number, b: number) { return a + b; }
function toFixedStr(n: number) {
  const s = n.toString();
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

async function priceToUsdOrNull(symbol: 'DOGE', amountStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter(k => typeof (fx as any)[k] === 'function');
    if (!fns.length) return null;
    const getPrices = (fx as any)[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices([symbol]);
    const usd = prices?.[symbol] ?? prices?.[symbol.toLowerCase()];
    const amt = parseFloat(amountStr || '0');
    if (typeof usd !== 'number' || !Number.isFinite(amt)) return null;
    return { usd: +(amt * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// -------- RPC --------
async function rpc(method: string, params: any[]): Promise<RpcOk | RpcErr> {
  if (!DOGE_RPC_URL) return { ok: false, error: 'missing_doge_rpc_url' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (NOWNODES_API_KEY) { headers['api-key'] = NOWNODES_API_KEY; headers['x-api-key'] = NOWNODES_API_KEY; }
    const res = await fetch(DOGE_RPC_URL, { method: 'POST', headers, body, cache: 'no-store' });
    const txt = await res.text();
    let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!res.ok) return { ok: false, error: `rpc_http_${res.status}:${txt || 'no_body'}` };
    if (j?.error) return { ok: false, error: `rpc_${j.error?.code}:${j.error?.message}` };
    return { ok: true, result: j?.result };
  } catch (e: any) {
    return { ok: false, error: `rpc_network:${e?.message || 'unknown'}` };
  }
}
const getRawTransactionVerbose = (txid: string) => rpc('getrawtransaction', [txid, true]);
const getRawTransactionHex = (txid: string) => rpc('getrawtransaction', [txid]);
const decodeRawTransaction = (hex: string) => rpc('decoderawtransaction', [hex]);
const getBlock = (blockhash: string) => rpc('getblock', [blockhash]);

function extractAddresses(spk: any): string[] {
  const out: string[] = [];
  if (!spk || typeof spk !== 'object') return out;
  if (typeof spk.address === 'string' && spk.address) out.push(spk.address);
  if (Array.isArray(spk.addresses)) for (const a of spk.addresses) if (a) out.push(String(a));
  return Array.from(new Set(out));
}

// -------- DB helpers --------
async function findDogeWalletIds(addrs: string[]): Promise<Record<string, string>> {
  if (!addrs.length) return {};
  const { data } = await supa().from('wallets').select('id,address,chain').eq('chain','doge').in('address', addrs);
  const map: Record<string, string> = {};
  if (Array.isArray(data)) for (const w of data) if (w?.address) map[String(w.address)] = String(w.id);
  return map;
}

// -------- handler --------
export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) return json(401, { ok:false, code:'unauthorized', message:'Unauthorized.' });

  // input
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  let txid = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  if (!txid) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });
  txid = normalizeTxId(txid);
  if (!isTxId64Hex(txid)) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });

  // idempotent check
  {
    const { data: found } = await supa().from('contributions').select('id').eq('tx_hash', txid).limit(1);
    if (found && found.length) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash: txid } });
    }
  }

  // tx fetch & decode
  let tx: any = null;
  let blockhash: string | null = null;
  let confirmations = 0;

  const v = await getRawTransactionVerbose(txid);
  if (v.ok && v.result) {
    tx = v.result;
    blockhash = typeof tx?.blockhash === 'string' ? tx.blockhash : null;
    confirmations = Number(tx?.confirmations || 0);
  } else {
    const h = await getRawTransactionHex(txid);
    if (!h.ok || !h.result) {
      return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash: txid } });
    }
    const d = await decodeRawTransaction(String(h.result));
    if (!d.ok || !d.result) {
      return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash: txid } });
    }
    tx = d.result;
    confirmations = 0;
  }

  if (confirmations <= 0) {
    return json(200, { ok:false, code:'rpc_error', message:'Transaction is not yet confirmed on-chain.', data:{ txHash: txid } });
  }

  if (!blockhash || typeof blockhash !== 'string') {
    return json(502, { ok:false, code:'rpc_error', message:'Unable to fetch block information.' });
  }
  const br = await getBlock(blockhash);
  if (!br.ok || !br.result || typeof br.result.time !== 'number') {
    return json(502, { ok:false, code:'rpc_error', message:'Unable to fetch block information.' });
  }
  const blockTimeISO = new Date(Number(br.result.time) * 1000).toISOString();

  const vout: any[] = Array.isArray(tx?.vout) ? tx.vout : [];
  const outAddresses = vout.flatMap((o) => extractAddresses(o?.scriptPubKey)).filter(Boolean);
  if (!outAddresses.length) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: txid } });
  }

  const addrToWalletId = await findDogeWalletIds(outAddresses);
  const ourAddrs = Object.keys(addrToWalletId);
  if (!ourAddrs.length) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: txid } });
  }

  let total = 0;
  let chosenWalletId: string | null = null;
  for (const o of vout) {
    const addrs = extractAddresses(o?.scriptPubKey);
    if (!addrs.length) continue;
    const hits = addrs.filter(a => addrToWalletId[a]);
    if (!hits.length) continue;
    const val = Number(o?.value || 0);
    if (Number.isFinite(val) && val > 0) {
      total += val;
      if (!chosenWalletId) chosenWalletId = addrToWalletId[hits[0]];
    }
  }

  if (!(total > 0) || !chosenWalletId) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: txid } });
  }

  const amountStr = toFixedStr(total);
  const priced = await priceToUsdOrNull('DOGE', amountStr);

  const payload: Record<string, any> = {
    wallet_id: chosenWalletId,
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

  return json(200, { ok:true, code:'inserted', message:'The transaction was successfully recorded on our project.', data:{ txHash: txid, inserted: ins ?? null } });
}

