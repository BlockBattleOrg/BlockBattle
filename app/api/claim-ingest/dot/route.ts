// app/api/claim-ingest/dot/route.ts
// DOT claim-ingest using Redis cache (from /api/indexers/dot) + on-demand micro-scan fallback.
// Returns: inserted | duplicate | not_project_wallet | tx_not_found | invalid_payload | rpc_error
//
// ENV: CRON_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//      NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      DOT_RPC_URL (for on-demand fallback scan), DOT_CLAIM_LOOKBACK (optional, default 120)

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
const DOT_RPC_URL = process.env.DOT_RPC_URL || process.env.DOT_RPC_HTTP || '';

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// planck -> DOT (1 DOT = 10^10 planck)
function planckToDotString(p: string | number | bigint): string {
  const bn = typeof p === 'bigint' ? p : BigInt(String(p || '0'));
  const whole = bn / 10_000_000_000n;
  const frac = bn % 10_000_000_000n;
  const rest = frac.toString().padStart(10, '0').replace(/0+$/, '');
  return rest ? `${whole.toString()}.${rest}` : whole.toString();
}

// Validation + normalization: accept "0x<64hex>" or "<64hex>", return "<64hex>" lowercase (no 0x)
function normalizeHash64(input: string): string | null {
  const raw = String(input || '').trim();
  const no0x = raw.startsWith('0x') || raw.startsWith('0X') ? raw.slice(2) : raw;
  if (/^[0-9A-Fa-f]{64}$/.test(no0x)) return no0x.toLowerCase();
  return null;
}

// ---------- Redis (Upstash REST) ----------
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
async function redisSetEx(key: string, ttlSeconds: number, value: any) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const r = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(
    typeof value === 'string' ? value : JSON.stringify(value),
  )}?EX=${ttlSeconds}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  return r.ok;
}

// ---------- Pricing (best-effort) ----------
async function priceDotToUsdOrNull(amountStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices', 'fetchUsdPrices', 'getPrices', 'pricesForSymbols'].filter(
      (k) => typeof (fx as any)[k] === 'function'
    );
    if (!fns.length) return null;
    const getPrices = (fx as any)[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['DOT']);
    const usd = prices?.DOT ?? prices?.dot;
    const amt = parseFloat(amountStr || '0');
    if (typeof usd !== 'number' || !Number.isFinite(amt)) return null;
    return { usd: +(amt * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

// ---------- On-demand micro-scan (fallback) ----------
// Skener je **strogo limitiran** na kratko trajanje (time budget) i manji lookback kako ne bi visio.
async function findDotTxOnChain(txHash64: string, lookback: number, timeBudgetMs: number): Promise<{ to: string; amount_planck: string; block_time: string } | null | 'timeout'> {
  if (!DOT_RPC_URL) return null;

  let ApiPromise: any, HttpProvider: any;
  try {
    const mod = await import('@polkadot/api');
    ApiPromise = mod.ApiPromise;
    HttpProvider = mod.HttpProvider;
  } catch {
    return null;
  }

  const deadline = Date.now() + timeBudgetMs;

  let api: any;
  try {
    const provider = new HttpProvider(DOT_RPC_URL);
    api = await ApiPromise.create({ provider });
  } catch {
    return null;
  }

  try {
    const finalizedHash = await api.rpc.chain.getFinalizedHead();
    const finalizedHeader = await api.rpc.chain.getHeader(finalizedHash);
    const finalizedNumber = finalizedHeader.number.toNumber();
    const start = Math.max(0, finalizedNumber - lookback);

    // helper: timestamp only when needed
    async function getBlockTimeISO(hash: any): Promise<string> {
      try {
        const ts = await (api.query.timestamp.now as any).at(hash);
        const ms = ts?.toNumber?.() ?? ts?.toBn?.()?.toNumber?.() ?? null;
        return ms ? new Date(ms).toISOString() : new Date().toISOString();
      } catch {
        return new Date().toISOString();
      }
    }

    const decodeOne = (c: any) => {
      const s = c.section?.toString?.() || '';
      const m = c.method?.toString?.() || '';
      if (s === 'balances' && (m === 'transfer' || m === 'transferKeepAlive')) {
        const dest = c.args[0];
        const value = c.args[1];
        const to = dest.toString();
        const amt = BigInt(value?.toString?.() || '0');
        return { to, amountPlanck: amt };
      }
      return null;
    };

    for (let n = finalizedNumber; n >= start; n--) {
      if (Date.now() > deadline) return 'timeout';

      const blockHash = await api.rpc.chain.getBlockHash(n);
      const block = await api.rpc.chain.getBlock(blockHash);

      // pre-scan extrinsics by hash
      let matchedCall: any | null = null;
      for (const ext of block.block.extrinsics) {
        const extHash = ext.hash.toHex().replace(/^0x/, '').toLowerCase();
        if (extHash !== txHash64) continue;
        matchedCall = ext.method;
        break;
      }
      if (!matchedCall) continue;

      // we have a match → decode transfer or batch
      const section = matchedCall.section?.toString?.() || '';
      const method = matchedCall.method?.toString?.() || '';
      const blockTimeISO = await getBlockTimeISO(blockHash);

      const direct = decodeOne(matchedCall);
      if (direct) {
        return { to: direct.to, amount_planck: direct.amountPlanck.toString(), block_time: blockTimeISO };
      }

      if (section === 'utility' && (method === 'batch' || method === 'batchAll')) {
        const calls = matchedCall.args?.[0];
        if (calls && typeof (calls as any)[Symbol.iterator] === 'function') {
          for (const c of calls as any[]) {
            const x = decodeOne(c);
            if (x) {
              return { to: x.to, amount_planck: x.amountPlanck.toString(), block_time: blockTimeISO };
            }
          }
        }
      }

      // extrinsic found ali nije transfer → za naš use-case nije primjenjivo
      return null;
    }

    return null;
  } catch {
    return null;
  } finally {
    try { await api?.disconnect?.(); } catch {}
  }
}

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
  const rawTx = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  const txHash = normalizeHash64(rawTx);
  if (!txHash) {
    return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });
  }

  // idempotent pre-check
  {
    const { data: found, error } = await supa().from('contributions').select('id').eq('tx_hash', txHash).limit(1);
    if (!error && found && found.length) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash } });
    }
  }

  // 1) Try Redis cache
  const cacheKey = `dot:tx:${txHash}`;
  let cacheRaw = await redisGet(cacheKey);

  // 2) Fallback: on-demand micro-scan with tight limits
  if (!cacheRaw) {
    const defaultLookback = Math.max(1, Math.min(2000, Number(process.env.DOT_CLAIM_LOOKBACK || 120)));
    const lookbackParam = Number(url.searchParams.get('lookback') || defaultLookback);
    const lookback = Math.max(1, Math.min(2000, lookbackParam));
    const timeBudgetMs = Math.max(2000, Math.min(12000, Number(url.searchParams.get('timeMs') || 8000)));

    const found = await findDotTxOnChain(txHash, lookback, timeBudgetMs);
    if (found === 'timeout') {
      return json(200, { ok:false, code:'rpc_error', message:'Lookup timed out. Please try again with a smaller lookback.', data:{ txHash } });
    }
    if (found) {
      await redisSetEx(cacheKey, 60 * 60 * 24 * 14, found);
      cacheRaw = JSON.stringify(found);
    }
  }

  if (!cacheRaw) {
    return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash } });
  }

  // Parse cache
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

