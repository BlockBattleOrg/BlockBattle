// app/api/ingest/atom/route.ts
import { NextResponse } from 'next/server';
import { setIntSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Add api-key header automatically for *.nownodes.io
function addHeaders(urlStr: string) {
  const h: Record<string, string> = { Accept: 'application/json' };
  try {
    const u = new URL(urlStr);
    if (u.hostname.endsWith('nownodes.io') && process.env.NOWNODES_API_KEY) {
      h['api-key'] = process.env.NOWNODES_API_KEY!;
    }
  } catch {}
  return h;
}

async function tryFetchJSON(url: string) {
  const res = await fetch(url, { headers: addHeaders(url), cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/**
 * POST /api/ingest/atom
 * Prefer REST (Cosmos SDK gRPC-gateway), uz nekoliko poznatih prefiksa.
 * Fallback: Tendermint /status (ako provider izlaže CometBFT RPC).
 * Piše: atom_last_height
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
    const candidates = [
      `${base}/cosmos/base/tendermint/v1beta1/blocks/latest`,
      `${base}/api/cosmos/base/tendermint/v1beta1/blocks/latest`,
      `${base}/api/v1/cosmos/base/tendermint/v1beta1/blocks/latest`,
      `${base}/status`,
    ];

    let height: number | null = null;
    let lastErr: any = null;

    for (const url of candidates) {
      try {
        const data = await tryFetchJSON(url);

        // REST (SDK ≥ v0.47)
        const hStr =
          data?.block?.header?.height ??
          data?.sdk_block?.header?.height ??
          null;
        if (hStr != null && Number.isFinite(Number(hStr))) {
          height = Number(hStr);
          break;
        }

        // Tendermint /status
        const latest = data?.result?.sync_info?.latest_block_height;
        if (latest != null && Number.isFinite(Number(latest))) {
          height = Number(latest);
          break;
        }

        if (data?.height != null && Number.isFinite(Number(data.height))) {
          height = Number(data.height);
          break;
        }
      } catch (e) {
        lastErr = e;
        continue;
      }
    }

    if (!Number.isFinite(height as number)) {
      const msg = lastErr ? `ATOM: upstream not found (${String(lastErr)})` : 'ATOM: unable to resolve height';
      return NextResponse.json({ ok: false, error: msg }, { status: 502 });
    }

    await setIntSetting('atom_last_height', height as number);
    return NextResponse.json({ ok: true, chain: 'ATOM', height, saved: true });
  } catch (err: any) {
    console.error('[ATOM_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

