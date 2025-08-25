// app/api/ingest/trx/route.ts
import { NextResponse } from 'next/server';
import { setIntSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function stripTrailingSlash(url: string) {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function headersFor(urlStr: string) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const u = new URL(urlStr);
    if (u.hostname.endsWith('nownodes.io') && process.env.NOWNODES_API_KEY) {
      h['api-key'] = process.env.NOWNODES_API_KEY!;
    }
  } catch {}
  return h;
}

/**
 * POST /api/ingest/trx
 * Tron FullNode REST: POST <root>/wallet/getnowblock with empty body
 * Height se nalazi na: block_header.raw_data.number (fallback i na block_header.number / number)
 * Piše u settings: trx_last_height
 */
export async function POST(request: Request) {
  try {
    // Optional gate
    const sec = process.env.CRON_SECRET;
    if (sec && request.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const root = process.env.TRX_RPC_URL;
    if (!root) {
      return NextResponse.json({ ok: false, error: 'Missing TRX_RPC_URL' }, { status: 500 });
    }

    const url = `${stripTrailingSlash(root)}/wallet/getnowblock`;
    const res = await fetch(url, {
      method: 'POST',
      headers: headersFor(url),
      body: '{}',
      cache: 'no-store',
    });

    if (!res.ok) throw new Error(`TRX HTTP ${res.status} ${res.statusText}`);

    const json = await res.json();
    const height =
      json?.block_header?.raw_data?.number ??
      json?.block_header?.number ??
      json?.number ??
      null;

    if (!Number.isFinite(Number(height))) {
      return NextResponse.json({ ok: false, error: 'TRX: invalid height' }, { status: 502 });
    }

    await setIntSetting('trx_last_height', Number(height));

    return NextResponse.json({
      ok: true,
      chain: 'TRX',
      height: Number(height),
      saved: true,
    });
  } catch (err: any) {
    console.error('[TRX_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

