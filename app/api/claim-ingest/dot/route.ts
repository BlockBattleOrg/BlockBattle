// app/api/claim-ingest/dot/route.ts
// DOT claim-ingest using Redis cache filled by /api/indexers/dot.
// Contract aligned with other chains: inserted | duplicate | not_project_wallet | tx_not_found | invalid_payload | rpc_error
//
// ENV: CRON_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//      NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;
const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });

const CRON_SECRET = process.env.CRON_SECRET || '';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

// planck -> DOT (1 DOT = 10^10 planck)
function planckToDotString(p: string | number | bigint): string {
  const bn = typeof p === 'bigint' ? p : BigInt(String(p || '0'));
  const whole = bn / 10_000_000_000n;
  const frac = bn % 10_000_000_000n;
  const rest = frac.toString().padStart(10, '0').replace(/0+$/, '');
  return rest ? `${whole.toString()}.${rest}` : whole.toString();
}

// Redis GET
async function redisGet(key: string) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    cache: 'no-store',
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.result ?? null;
}

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// Cosmos-like pricing helper reused: best-effort via lib/fx if present
async function priceDotToUsdOrNull(amountStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter(k => typeof (fx as any)[k] === 'function');
    if (!fns.length) return null;
    const getPrices = (fx as any)[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['DOT']);
    const usd = prices?.DOT ?? prices?.dot;
    const amt = parseFloat(amountStr || '0');
    if (typeof usd !== 'number' || !Number.isFinite(amt)) return null;
    return { usd: +(amt * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// Validation: Substrate extrinsic hash is 64-hex (no 0x)
const is64hex = (s: string) => /^[0-9A-Fa-f]{64}$/.test(String(s || '').trim());

export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok:false, code:'unauthorized', message:'Unauthorized.' });
  }
  if (!REDIS_URL || !REDIS_TOKEN) {
    return json(502, { ok:false, code:'rpc_error', message:'Redis (Upstash) is not configured.' });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  let txHash = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  if (!txHash || !is64hex(txHash)) {
    return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });
  }

  // idempotent pre-check
  {
    const { data: found, error } = await supa().from('contributions').select('id').eq('tx_hash', txHash).limit(1);
    if (!error && found && found.length) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash } });
    }
  }

  // Lookup in Redis cache prepared by indexer
  const cacheKey = `dot:tx:${txHash.toLowerCase()}`;
  let cacheRaw = await redisGet(cacheKey);
  if (!cacheRaw) {
    // tolerant: some writers might store without lowercasing
    cacheRaw = await redisGet(`dot:tx:${txHash}`);
  }
  if (!cacheRaw) {
    return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash } });
  }

  // cache value is JSON: { to, amount_planck, block_time }
  let cached: any = null;
  try {
    cached = typeof cacheRaw === 'string' ? JSON.parse(cacheRaw) : cacheRaw;
  } catch {
    return json(502, { ok:false, code:'rpc_error', message:'Cached transaction is malformed.' });
  }

  const toAddr: string = String(cached?.to || '');
  const amountPlanckStr: string = String(cached?.amount_planck || '0');
  const blockTimeISO: string = typeof cached?.block_time === 'string' ? cached.block_time : new Date().toISOString();

  if (!toAddr || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(toAddr)) {
    // if "to" not present or not a plausible SS58 string, treat as not ours
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash } });
  }

  // Map to wallet_id
  const { data: wallet } = await supa()
    .from('wallets')
    .select('id,address,chain')
    .eq('chain','dot')
    .eq('address', toAddr)
    .limit(1);
  if (!wallet || !wallet.length) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash } });
  }
  const wallet_id = String(wallet[0].id);

  // Amount
  const amountDotStr = planckToDotString(amountPlanckStr);

  // Pricing
  const priced = await priceDotToUsdOrNull(amountDotStr);

  // Insert
  const payload: Record<string, any> = {
    wallet_id,
    tx_hash: txHash,
    amount: amountDotStr,
    block_time: blockTimeISO,
  };
  if (priced) { payload.amount_usd = priced.usd; payload.priced_at = priced.pricedAt; }
  if (note) payload.note = note;

  const { data: ins, error: insErr } = await supa().from('contributions').insert(payload).select('id').maybeSingle();
  if (insErr) {
    const msg = String(insErr.message || ''); const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash } });
    }
    return json(400, { ok:false, code:'db_error', message:'Database write error.' });
  }

  return json(200, {
    ok: true,
    code: 'inserted',
    message: 'The transaction was successfully recorded on our project.',
    data: { txHash, inserted: ins ?? null },
  });
}

