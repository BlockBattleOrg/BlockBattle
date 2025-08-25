// app/api/ingest/sol/route.ts
import { NextResponse } from 'next/server';
import { setIntSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

async function solRpc<T = any>(url: string, method: string, params: any[] = []): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
  const res = await fetch(url, { method: 'POST', headers: headersFor(url), body, cache: 'no-store' });
  if (!res.ok) throw new Error(`SOL HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json?.error) throw new Error(`SOL RPC error: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

/**
 * POST /api/ingest/sol
 * Solana JSON-RPC: getBlockHeight (finalized)
 * Piše u settings: sol_last_height
 */
export async function POST(request: Request) {
  try {
    const sec = process.env.CRON_SECRET;
    if (sec && request.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.SOL_RPC_URL;
    if (!url) return NextResponse.json({ ok: false, error: 'Missing SOL_RPC_URL' }, { status: 500 });

    // commitment param as object (preferred)
    const height = await solRpc<number>(url, 'getBlockHeight', [{ commitment: 'finalized' }]);
    if (!Number.isFinite(Number(height))) {
      return NextResponse.json({ ok: false, error: 'SOL: invalid height' }, { status: 502 });
    }

    await setIntSetting('sol_last_height', Number(height));

    return NextResponse.json({ ok: true, chain: 'SOL', height: Number(height), saved: true });
  } catch (err: any) {
    console.error('[SOL_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

