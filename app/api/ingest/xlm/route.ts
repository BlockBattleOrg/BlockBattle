// app/api/ingest/xlm/route.ts
import { NextResponse } from 'next/server';
import { setIntSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function headersFor(urlStr: string) {
  const h: Record<string, string> = { Accept: 'application/json' };
  try {
    const u = new URL(urlStr);
    if (u.hostname.endsWith('nownodes.io') && process.env.NOWNODES_API_KEY) {
      h['api-key'] = process.env.NOWNODES_API_KEY!;
    }
  } catch {}
  return h;
}

/**
 * POST /api/ingest/xlm
 * Horizon REST: GET <HORIZON>/ledgers?order=desc&limit=1
 * -> _embedded.records[0].sequence  (latest ledger)
 * Piše u settings: xlm_last_height
 */
export async function POST(request: Request) {
  try {
    const sec = process.env.CRON_SECRET;
    if (sec && request.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const base = process.env.XLM_HORIZON_URL;
    if (!base) {
      return NextResponse.json({ ok: false, error: 'Missing XLM_HORIZON_URL' }, { status: 500 });
    }
    const url = `${base.replace(/\/$/, '')}/ledgers?order=desc&limit=1`;

    const res = await fetch(url, { headers: headersFor(url), cache: 'no-store' });
    if (!res.ok) throw new Error(`Horizon HTTP ${res.status} ${res.statusText}`);

    const json = await res.json();
    const seq = json?._embedded?.records?.[0]?.sequence;
    const height = Number(seq);

    if (!Number.isFinite(height)) {
      return NextResponse.json({ ok: false, error: 'XLM: invalid sequence' }, { status: 502 });
    }

    await setIntSetting('xlm_last_height', height);

    return NextResponse.json({ ok: true, chain: 'XLM', height, saved: true });
  } catch (err: any) {
    console.error('[XLM_INGEST_ERROR]', err);
    return NextResponse.json({ ok: false, error: err?.message || 'Unexpected error' }, { status: 500 });
  }
}

