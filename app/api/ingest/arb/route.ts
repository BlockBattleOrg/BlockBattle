// app/api/ingest/arb/route.ts
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

    const url = process.env.ARB_RPC_URL;
    if (!url) {
      return NextResponse.json({ ok: false, error: 'Missing ARB_RPC_URL' }, { status: 500 });
    }

    const height = await getLatestBlockNumber(url);
    await setIntSetting('arb_last_height', height);

    return NextResponse.json({ ok: true, chain: 'ARB', height, saved: true });
  } catch (err: any) {
    console.error('[ARB_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

