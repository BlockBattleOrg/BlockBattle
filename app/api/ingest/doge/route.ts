import { NextResponse } from 'next/server';
import { rpcCall } from '@/lib/rpc';
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

    if (!process.env.NOWNODES_API_KEY) {
      return NextResponse.json(
        { ok: false, error: 'Missing NOWNODES_API_KEY in environment' },
        { status: 500 }
      );
    }

    const bestHash = await rpcCall<string>('DOGE', 'getbestblockhash');
    const header = await rpcCall<any>('DOGE', 'getblockheader', [bestHash, true]);

    if (header?.height != null) {
      await setIntSetting('doge_last_height', Number(header.height));
    }

    return NextResponse.json({
      ok: true,
      chain: 'DOGE',
      height: header?.height ?? null,
      hash: bestHash,
      timestamp: header?.time ?? null,
      saved: true,
    });
  } catch (err: any) {
    console.error('[DOGE_INGEST_ERROR]', err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}

