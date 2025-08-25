// app/api/ingest/atom/route.ts
import { NextResponse } from 'next/server';
import { setIntSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Add api-key header automatically for *.nownodes.io
function headersFor(urlStr: string) {
  const h: Record<string, string> = { 'Accept': 'application/json' };
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
 * Cosmos REST (gRPC-gateway):
 *   GET <root>/cosmos/base/tendermint/v1beta1/blocks/latest
 *   -> height nalazi se u block.header.height (ili sdk_block.header.height)
 * Piše u settings: atom_last_height
 */
export async function POST(request: Request) {
  try {
    const sec = process.env.CRON_SECRET;
    if (sec && request.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const root = process.env.ATOM_RPC_URL;
    if (!root) return NextResponse.json({ ok: false, error: 'Missing ATOM_RPC_URL' }, { status: 500 });

    const base = root.replace(/\/$/, '');
    const url = `${base}/cosmos/base/tendermint/v1beta1/blocks/latest`;

    const res = await fetch(url, { headers: headersFor(url), cache: 'no-store' });
    if (!res.ok) throw new Error(`ATOM REST HTTP ${res.status} ${res.statusText}`);

    const json = await res.json();
    const hStr =
      json?.block?.header?.height ??
      json?.sdk_block?.header?.height ??
      null;
    const height = hStr != null ? Number(hStr) : null;

    if (Number.isFinite(height)) {
      await setIntSetting('atom_last_height', height as number);
    }

    return NextResponse.json({
      ok: true,
      chain: 'ATOM',
      height: Number.isFinite(height as number) ? (height as number) : null,
      saved: true,
    });
  } catch (err: any) {
    console.error('[ATOM_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

