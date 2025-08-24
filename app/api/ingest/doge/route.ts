// app/api/ingest/doge/route.ts
import { NextResponse } from 'next/server';
import { rpcCall } from '@/lib/rpc';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/ingest/doge
 * NowNodes smoke-test + hook za tvoju normalizaciju/upsert.
 * Poštuje "x-cron-secret" ako je CRON_SECRET postavljen.
 */
export async function POST(request: Request) {
  try {
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

    const bestHash = await rpcCall<string>('DOGE', 'getbestblockhash');
    const header = await rpcCall<any>('DOGE', 'getblockheader', [bestHash, true]);
    // const block = await rpcCall<any>('DOGE', 'getblock', [bestHash, 2]);

    // TODO: normalizacija + upsert u tvoju bazu
    return NextResponse.json({
      ok: true,
      chain: 'DOGE',
      height: header?.height ?? null,
      hash: bestHash,
      timestamp: header?.time ?? null,
      note: 'NowNodes adapter OK (DOGE). Dodaj normalizaciju/upsert gdje je označeno.',
    });
  } catch (err: any) {
    console.error('[DOGE_INGEST_ERROR]', err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}

