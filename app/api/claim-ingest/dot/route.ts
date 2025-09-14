// app/api/claim-ingest/dot/route.ts
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CRON_SECRET = process.env.CRON_SECRET || '';

function json(status: number, payload: Record<string, unknown>) {
  return NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok:false, code:'unauthorized', message:'Unauthorized.' });
  }
  return json(200, {
    ok:false,
    code:'unsupported_chain',
    message:'Polkadot (DOT) claims are not supported at the moment.',
  });
}

