// app/api/ingest/xrp/route.ts
import { NextResponse } from 'next/server';
import { setIntSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Dodaj api-key za *.nownodes.io
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

async function callXrp(url: string, method: string, params: any = {}) {
  const body = JSON.stringify({ method, params: [params] });
  const res = await fetch(url, { method: 'POST', headers: headersFor(url), body, cache: 'no-store' });
  if (!res.ok) throw new Error(`XRP HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json?.result?.status !== 'success') {
    throw new Error(`XRP RPC error: ${JSON.stringify(json?.result ?? json)}`);
  }
  return json.result;
}

/**
 * POST /api/ingest/xrp
 * Preferira "server_info" (validated_ledger.seq), fallback na "ledger" (ledger_index: validated)
 * Upisuje settings key: xrp_last_height
 */
export async function POST(request: Request) {
  try {
    const sec = process.env.CRON_SECRET;
    if (sec && request.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = process.env.XRP_RPC_URL;
    if (!url) {
      return NextResponse.json({ ok: false, error: 'Missing XRP_RPC_URL' }, { status: 500 });
    }

    let height: number | null = null;

    // 1) Brži poziv: server_info → info.validated_ledger.seq
    try {
      const r1 = await callXrp(url, 'server_info');
      const seq = r1?.info?.validated_ledger?.seq;
      if (Number.isFinite(Number(seq))) {
        height = Number(seq);
      }
    } catch {
      // ignore, probat ćemo fallback
    }

    // 2) Fallback: ledger(validated) → ledger.ledger_index
    if (!Number.isFinite(height as number)) {
      const r2 = await callXrp(url, 'ledger', { ledger_index: 'validated' });
      const idx = r2?.ledger?.ledger_index ?? r2?.ledger_index;
      if (Number.isFinite(Number(idx))) {
        height = Number(idx);
      }
    }

    if (!Number.isFinite(height as number)) {
      return NextResponse.json({ ok: false, error: 'XRP: unable to resolve validated height' }, { status: 502 });
    }

    await setIntSetting('xrp_last_height', height as number);

    return NextResponse.json({
      ok: true,
      chain: 'XRP',
      height,
      saved: true,
    });
  } catch (err: any) {
    console.error('[XRP_INGEST_ERROR]', err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}

