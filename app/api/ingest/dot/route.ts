// app/api/ingest/dot/route.ts
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
 * POST /api/ingest/dot
 * Uses Substrate JSON-RPC:
 *  - chain_getFinalizedHead -> hash
 *  - chain_getHeader(hash)  -> header.number (hex) -> height
 * Writes settings key: dot_last_height
 */
export async function POST(request: Request) {
  try {
    const sec = process.env.CRON_SECRET;
    if (sec && request.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.DOT_RPC_URL;
    if (!url) {
      return NextResponse.json({ ok: false, error: 'Missing DOT_RPC_URL' }, { status: 500 });
    }

    // 1) get finalized head hash
    const headRes = await fetch(url, {
      method: 'POST',
      headers: headersFor(url),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getFinalizedHead', params: [] }),
      cache: 'no-store',
    });
    if (!headRes.ok) throw new Error(`DOT RPC HTTP ${headRes.status}`);
    const headJson = await headRes.json();
    const hash = headJson?.result;

    // 2) get header for that hash
    const hdrRes = await fetch(url, {
      method: 'POST',
      headers: headersFor(url),
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'chain_getHeader', params: [hash] }),
      cache: 'no-store',
    });
    if (!hdrRes.ok) throw new Error(`DOT RPC HTTP ${hdrRes.status}`);
    const hdrJson = await hdrRes.json();
    const hex = hdrJson?.result?.number;
    const height = typeof hex === 'string' ? parseInt(hex, 16) : null;

    if (Number.isFinite(height)) {
      await setIntSetting('dot_last_height', height as number);
    }

    return NextResponse.json({
      ok: true,
      chain: 'DOT',
      height: Number.isFinite(height as number) ? (height as number) : null,
      saved: true,
    });
  } catch (err: any) {
    console.error('[DOT_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

