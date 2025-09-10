// app/api/indexers/dot/route.ts
// DOT light indexer (finalized blocks) -> Redis cache for claim-first.
// - Scans up to ?maxBlocks (default 25) from cursor to finalized
// - Decodes balances.transfer/transferKeepAlive (+ shallow utility.batch/batchAll)
// - If "to" is our wallet (wallets.chain='dot'), cache in Redis: dot:tx:<hash> = {to, amount, block_time}
// - DOES NOT write to Supabase contributions (claim-ingest will do that)
// ENV needed: DOT_RPC_URL, CRON_SECRET, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
//             NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;
const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });

const CRON_SECRET = process.env.CRON_SECRET || '';
const DOT_RPC_URL = process.env.DOT_RPC_URL || process.env.DOT_RPC_HTTP || '';
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- Redis helpers (Upstash REST) ----------
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

async function redisSet(key: string, value: any) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  const r = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(
    typeof value === 'string' ? value : JSON.stringify(value),
  )}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  return r.ok;
}

// ---------- Indexer ----------
export async function POST(req: NextRequest) {
  // Auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok: false, code: 'unauthorized', message: 'Unauthorized.' });
  }
  if (!DOT_RPC_URL) {
    return json(502, { ok: false, code: 'rpc_error', message: 'DOT RPC URL is not configured.' });
  }
  if (!REDIS_URL || !REDIS_TOKEN) {
    return json(502, { ok: false, code: 'rpc_error', message: 'Redis (Upstash) is not configured.' });
  }

  // Params
  const url = new URL(req.url);
  const maxBlocks = Math.max(1, Math.min(100, Number(url.searchParams.get('maxBlocks') || 25)));
  const ttl = Math.max(3600, Math.min(60 * 60 * 24 * 14, Number(url.searchParams.get('ttl') || (60 * 60 * 24 * 14)))); // default 14d

  // Load DOT wallets once (SS58 strings)
  const { data: wallets, error: wErr } = await supa()
    .from('wallets')
    .select('id,address,chain')
    .eq('chain', 'dot');
  if (wErr) return json(500, { ok: false, code: 'db_error', message: 'Failed to load wallets.' });

  const ourAddrs = new Set<string>((wallets || []).map((w: any) => String(w.address)));

  // Lazy-load @polkadot/api to avoid bundling overhead in other routes
  let ApiPromise: any, HttpProvider: any;
  try {
    const mod = await import('@polkadot/api');
    ApiPromise = mod.ApiPromise;
    HttpProvider = mod.HttpProvider;
  } catch (e: any) {
    return json(500, { ok: false, code: 'rpc_error', message: `Polkadot API not available: ${e?.message || 'unknown'}` });
  }

  // Connect
  let api: any;
  try {
    const provider = new HttpProvider(DOT_RPC_URL);
    api = await ApiPromise.create({ provider });
  } catch (e: any) {
    return json(502, { ok: false, code: 'rpc_error', message: `Failed to connect DOT RPC: ${e?.message || 'unknown'}` });
  }

  // Finalized head and number
  let finalizedHash: any, finalizedHeader: any, finalizedNumber = 0;
  try {
    finalizedHash = await api.rpc.chain.getFinalizedHead();
    finalizedHeader = await api.rpc.chain.getHeader(finalizedHash);
    finalizedNumber = finalizedHeader.number.toNumber();
  } catch (e: any) {
    return json(502, { ok: false, code: 'rpc_error', message: `Failed to read finalized head: ${e?.message || 'unknown'}` });
  }

  // Cursor
  const CURSOR_KEY = 'dot:indexer:cursor';
  let cursorNum = 0;
  try {
    const cur = await redisGet(CURSOR_KEY);
    if (cur) cursorNum = Number(cur) || 0;
  } catch {}
  if (!cursorNum || cursorNum > finalizedNumber) {
    // bootstrap a bit behind finalized to avoid gaps
    cursorNum = Math.max(0, finalizedNumber - 100);
    await redisSet(CURSOR_KEY, String(cursorNum));
  }

  const from = cursorNum + 1;
  const to = Math.min(finalizedNumber, cursorNum + maxBlocks);
  if (to < from) {
    return json(200, { ok: true, scanned: 0, from: cursorNum, to: cursorNum, finalized: finalizedNumber });
  }

  let scanned = 0;
  let lastScanned = cursorNum;

  // Helper to extract timestamp from block
  async function getBlockTimeISO(hash: any): Promise<string> {
    try {
      const tsNow = new Date().toISOString();
      // Query timestamp pallet storage at block
      const ts = await (api.query.timestamp.now as any).at(hash);
      const ms = ts?.toNumber?.() ?? ts?.toBn?.()?.toNumber?.() ?? null;
      if (!ms) return tsNow;
      return new Date(ms).toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  // Extract interesting transfers from extrinsic (and shallow batch calls)
  function* extractTransfersFromExtrinsic(api: any, ext: any): Generator<{ section: string; method: string; to: string; amountPlanck: bigint }> {
    const call = ext.method;
    const section = call.section?.toString?.() || '';
    const method = call.method?.toString?.() || '';

    const decodeOne = (c: any) => {
      const s = c.section?.toString?.() || '';
      const m = c.method?.toString?.() || '';
      if (s === 'balances' && (m === 'transfer' || m === 'transferKeepAlive')) {
        const dest = c.args[0]; // AccountId
        const value = c.args[1]; // Balance
        const to = dest.toString(); // ss58 string (network default)
        const amt = BigInt(value?.toString?.() || '0');
        return { section: s, method: m, to, amountPlanck: amt };
      }
      return null;
    };

    // direct balances.transfer
    const direct = decodeOne(call);
    if (direct) {
      yield direct;
      return;
    }
    // shallow utility.batch / batchAll
    if (section === 'utility' && (method === 'batch' || method === 'batchAll')) {
      const calls = call.args?.[0];
      if (Array.isArray(calls)) {
        for (const c of calls) {
          const x = decodeOne(c);
          if (x) yield x;
        }
      } else if (calls && typeof calls.forEach === 'function') {
        calls.forEach((c: any) => {
          const x = decodeOne(c);
          if (x) yield x;
        });
      }
    }
  }

  try {
    for (let n = from; n <= to; n++) {
      const blockHash = await api.rpc.chain.getBlockHash(n);
      const block = await api.rpc.chain.getBlock(blockHash);
      const blockTimeISO = await getBlockTimeISO(blockHash);

      // extrinsics loop
      for (const ext of block.block.extrinsics) {
        // Only success extrinsics? For baseline, accept all; claim route cares about our destination.
        const transfers = Array.from(extractTransfersFromExtrinsic(api, ext));
        if (!transfers.length) continue;

        const extHash = ext.hash.toHex().replace(/^0x/, '').toLowerCase();

        for (const t of transfers) {
          // Cache every transfer we see; claim route will decide if it's "our project"
          const cacheKey = `dot:tx:${extHash}`;
          const value = {
            to: t.to,                                      // ss58
            amount_planck: t.amountPlanck.toString(),      // string
            block_time: blockTimeISO,                      // ISO
          };
          // Save/refresh TTL
          await redisSetEx(cacheKey, ttl, value);
        }
      }

      scanned++;
      lastScanned = n;
      // update cursor progressively to avoid redo on long runs
      if (n % 5 === 0 || n === to) {
        await redisSet(CURSOR_KEY, String(n));
      }
    }
  } catch (e: any) {
    // still advance cursor to last scanned block to avoid tight loops
    if (lastScanned > cursorNum) await redisSet(CURSOR_KEY, String(lastScanned));
    return json(502, { ok: false, code: 'rpc_error', message: `Indexer error: ${e?.message || 'unknown'}`, scanned, toCursor: lastScanned, finalized: finalizedNumber });
  } finally {
    try { await api?.disconnect?.(); } catch {}
  }

  return json(200, { ok: true, scanned, from, to, finalized: finalizedNumber });
}

