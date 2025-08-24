// app/api/ingest/btc/route.ts
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

    // NowNodes RPC
    const bestHash = await rpcCall<string>('BTC', 'getbestblockhash');
    const header = await rpcCall<any>('BTC', 'getblockheader', [bestHash, true]);

    // Upsert u settings: standardizirani ključ
    if (header?.height != null) {
      await setIntSetting('btc_last_height', Number(header.height));
    }

    return NextResponse.json({
      ok: true,
      chain: 'BTC',
      height: header?.height ?? null,
      hash: bestHash,
      timestamp: header?.time ?? null,
      saved: true,
    });
  } catch (err: any) {
    console.error('[BTC_INGEST_ERROR]', err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}

