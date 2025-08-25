// app/api/ingest/atom/route.ts
import { NextResponse } from 'next/server';
import { setIntSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Add api-key header automatically for *.nownodes.io
function headersFor(urlStr: string) {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const u = new URL(urlStr);
    if (u.hostname.endsWith('nownodes.io') && process.env.NOWNODES_API_KEY) {
      h['api-key'] = process.env.NOWNODES_API_KEY;
    }
  } catch {}
  return h;
}

/**
 * POST /api/ingest/atom
 * Tendermint RPC:
 *   GET <root>/status  → result.sync_info.latest_block_height
 * Piše u settings: atom_last_height
 */
export async function POST(request: Request) {
  try {
    const sec = process.env.CRON_SECRET;
    if (sec && request.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const root = process.env.ATOM_RPC_URL;
    if (!root) {
      return NextResponse.json({ ok: false, error: 'Missing ATOM_RPC_URL' }, { status: 500 });
    }

    const url = `${root.replace(/\/$/, '')}/status`;
    const res = await fetch(url, { headers: headersFor(root), cache: 'no-store' });
    if (!res.ok) throw new Error(`Tendermint HTTP ${res.status} ${res.statusText}`);

    const json = await res.json();
    const height = parseInt(json?.result?.sync_info?.latest_block_height ?? 'NaN', 10);

    if (Number.isFinite(height)) {
      await setIntSetting('atom_last_height', height);
    }

    return NextResponse.json({
      ok: true,
      chain: 'ATOM',
      height: Number.isFinite(height) ? height : null,
      saved: true,
    });
  } catch (err: any) {
    console.error('[ATOM_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

