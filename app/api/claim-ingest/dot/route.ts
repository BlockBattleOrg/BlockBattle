// app/api/claim-ingest/dot/route.ts
// Polkadot (DOT) — stub route.
// Objašnjenje: Substrate JSON-RPC ne pruža pouzdan "extrinsic-by-hash" lookup bez indexera.
// Za siguran ingest (detekcija destinacije i amount) treba Subscan/Indexer ili vlastiti indeksni servis.
// Ova ruta validira format hash-a i odmah vraća 'unsupported_chain' bez ikakvih upisa u bazu.
//
// ENV (za buduće proširenje): DOT_RPC_URL, NOWNODES_API_KEY

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CRON_SECRET = process.env.CRON_SECRET || '';

type J = Record<string, unknown>;
const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });

// Polkadot/ Substrate extrinsic hash je 64-hex (bez 0x)
const is64hex = (s: string) => /^[0-9A-Fa-f]{64}$/.test(String(s || '').trim());

export async function POST(req: NextRequest) {
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok:false, code:'unauthorized', message:'Unauthorized.' });
  }

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  const raw = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();

  if (!raw || !is64hex(raw)) {
    return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });
  }

  // Jasno i nedvosmisleno: ova verzija je stub da ne bi davala krive rezultate.
  return json(200, {
    ok: false,
    code: 'unsupported_chain',
    message: 'Polkadot claims are not supported yet (requires an indexer to resolve extrinsics by hash).',
    data: { txHash: raw },
  });
}

