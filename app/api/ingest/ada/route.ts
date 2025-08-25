// app/api/ingest/ada/route.ts
import { NextResponse } from 'next/server';
import { setIntSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/ingest/ada
 * NOWNodes (Blockfrost-compatible) endpoint:
 *   base = ADA_BLOCKFROST_URL (e.g., https://ada-blockfrost.nownodes.io)
 *   GET /blocks/latest  (requires header: api-key)
 * Writes settings key: ada_last_height
 */
export async function POST(request: Request) {
  try {
    // Optional auth gate
    const sec = process.env.CRON_SECRET;
    if (sec && request.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const base = (process.env.ADA_BLOCKFROST_URL || '').replace(/\/$/, '');
    if (!base) {
      return NextResponse.json({ ok: false, error: 'Missing ADA_BLOCKFROST_URL' }, { status: 500 });
    }
    if (!process.env.NOWNODES_API_KEY) {
      return NextResponse.json({ ok: false, error: 'Missing NOWNODES_API_KEY' }, { status: 500 });
    }

    const res = await fetch(`${base}/blocks/latest`, {
      method: 'GET',
      headers: {
        'Accept': '*/*',
        'api-key': process.env.NOWNODES_API_KEY!,
      },
      cache: 'no-store',
    });

    if (!res.ok) throw new Error(`ADA HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();

    const height = json?.height != null ? Number(json.height) : null;
    if (Number.isFinite(height)) {
      await setIntSetting('ada_last_height', height as number);
    }

    return NextResponse.json({
      ok: true,
      chain: 'ADA',
      height: Number.isFinite(height as number) ? (height as number) : null,
      saved: true,
    });
  } catch (err: any) {
    console.error('[ADA_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

