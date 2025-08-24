// app/api/ingest/btc/route.ts
import { NextResponse } from 'next/server';
import { rpcCall } from '@/lib/rpc';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs'; // ensure Node runtime for server-side fetch

/**
 * POST /api/ingest/btc
 * Minimal NowNodes smoke-test + placeholder for your normalization/storage.
 * Keeps existing "x-cron-secret" gate if CRON_SECRET is set.
 */
export async function POST(request: Request) {
  try {
    // Optional auth gate: only enforce if CRON_SECRET is configured.
    const configuredSecret = process.env.CRON_SECRET;
    if (configuredSecret) {
      const reqSecret = request.headers.get('x-cron-secret');
      if (reqSecret !== configuredSecret) {
        return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
    }

    if (!process.env.NOWNODES_API_KEY) {
      return NextResponse.json(
        { ok: false, error: 'Missing NOWNODES_API_KEY in environment' },
        { status: 500 }
      );
    }

    // --- NowNodes RPC calls (Bitcoin-like) ---
    // 1) get latest block hash
    const bestHash = await rpcCall<string>('BTC', 'getbestblockhash');

    // 2) get verbose header (true → JSON with fields)
    const header = await rpcCall<any>('BTC', 'getblockheader', [bestHash, true]);

    // 3) (optional) fetch full block if/when you need txs for ingestion
    // const block = await rpcCall<any>('BTC', 'getblock', [bestHash, 2]); // verbosity 2 returns decoded txs

    // ---- TODO: your normalization + Supabase upsert goes here ----
    // e.g. await upsertBlock('BTC', header.height, bestHash, header.time, block);

    return NextResponse.json({
      ok: true,
      chain: 'BTC',
      height: header?.height ?? null,
      hash: bestHash,
      timestamp: header?.time ?? null,
      note: 'NowNodes adapter is working. Add your normalization/upsert where indicated.',
    });
  } catch (err: any) {
    // Surface meaningful error to logs and client
    console.error('[BTC_INGEST_ERROR]', err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}

