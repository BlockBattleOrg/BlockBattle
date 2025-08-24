// app/api/ingest/pol/route.ts
import { NextResponse } from 'next/server';
import { getLatestBlockNumber } from '@/lib/evm';
import { setIntSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const configuredSecret = process.env.CRON_SECRET;
    if (configuredSecret) {
      const reqSecret = request.headers.get('x-cron-secret');
      if (reqSecret !== configuredSecret) {
        return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
      }
    }

    // Back-compat: accept both POL_RPC_URL and MATIC_RPC_URL
    const url = process.env.POL_RPC_URL || process.env.MATIC_RPC_URL;
    if (!url) {
      return NextResponse.json({ ok: false, error: 'Missing POL_RPC_URL (or MATIC_RPC_URL)' }, { status: 500 });
    }

    const height = await getLatestBlockNumber(url);
    await setIntSetting('pol_last_height', height);

    return NextResponse.json({ ok: true, chain: 'POL', height, saved: true });
  } catch (err: any) {
    console.error('[POL_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

