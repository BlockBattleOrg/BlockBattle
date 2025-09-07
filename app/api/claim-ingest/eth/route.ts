// app/api/claim-ingest/eth/route.ts
// Single-tx ETH claim-ingest route (claim-first flow)
// - Guarded by x-cron-secret
// - Canonicalizes EVM tx hash (0x + lowercase)
// - Verifies on-chain via eth_getTransactionReceipt
// - Idempotent DB write: SELECT -> INSERT; duplicate => alreadyRecorded:true
// - Does NOT depend on a DB unique constraint

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Json = Record<string, unknown>;

// ------------ env / config ------------
const CRON_SECRET = process.env.CRON_SECRET || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';
// You can override this per-environment if needed:
const ETH_RPC_URL =
  process.env.ETH_RPC_URL ||
  process.env.EVM_RPC_URL ||
  'https://eth.nownodes.io';

// ------------ helpers ------------
function json(status: number, payload: Json) {
  return NextResponse.json(payload, { status });
}

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

function normalizeEvm(tx: string) {
  const raw = tx.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return ('0x' + raw).toLowerCase();
  return raw;
}
function isValidEvmHash(tx: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(tx);
}

// Minimal receipt check: confirmed if receipt exists AND has blockNumber
async function fetchEthReceipt(hash: string): Promise<
  | { ok: true; pending: false; receipt: any }
  | { ok: true; pending: true }
  | { ok: false; notFound: true }
  | { ok: false; error: string }
> {
  if (!ETH_RPC_URL) return { ok: false, error: 'missing_eth_rpc_url' };
  if (!NOWNODES_API_KEY && ETH_RPC_URL.includes('nownodes')) {
    return { ok: false, error: 'missing_nownodes_api_key' };
  }

  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_getTransactionReceipt',
    params: [hash],
  });

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // NowNodes supports either 'api-key' or 'x-api-key'
    if (NOWNODES_API_KEY) {
      headers['api-key'] = NOWNODES_API_KEY;
      headers['x-api-key'] = NOWNODES_API_KEY;
    }

    const res = await fetch(ETH_RPC_URL, { method: 'POST', headers, body });
    const raw = await res.text();
    let j: any = null;
    try { j = raw ? JSON.parse(raw) : null; } catch { /* pass */ }

    if (!res.ok) return { ok: false, error: `rpc_http_${res.status}:${raw || 'no_body'}` };
    if (j?.error) return { ok: false, error: `rpc_${j.error?.code}:${j.error?.message}` };

    const r = j?.result ?? null;
    if (!r) return { ok: false, notFound: true };
    if (!r.blockNumber) return { ok: true, pending: true };
    return { ok: true, pending: false, receipt: r };
  } catch (e: any) {
    return { ok: false, error: `rpc_network:${e?.message || 'unknown'}` };
  }
}

// ------------ handler ------------
export async function POST(req: NextRequest) {
  // 0) auth guard
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  // 1) input
  const url = new URL(req.url);
  let tx = (url.searchParams.get('tx') || '').trim();
  if (!tx) return json(400, { ok: false, error: 'missing_tx' });

  tx = normalizeEvm(tx);
  if (!isValidEvmHash(tx)) {
    return json(400, { ok: false, error: 'invalid_tx_format:expect_0x64_hex' });
  }

  // 2) on-chain verification
  const chk = await fetchEthReceipt(tx);
  if (!chk.ok) {
    if ((chk as any).notFound) return json(404, { ok: false, error: 'tx_not_found' });
    return json(502, { ok: false, error: (chk as any).error || 'rpc_error' });
  }
  if (chk.pending) {
    return json(409, { ok: false, error: 'tx_pending' });
  }

  // 3) idempotent write (no ON CONFLICT dependency)
  try {
    // 3a) exact pre-check
    const { data: found, error: qErr } = await supa()
      .from('contributions')
      .select('id')
      .eq('tx_hash', tx)
      .limit(1);

    if (!qErr && found && found.length > 0) {
      return json(200, { ok: true, inserted: null, alreadyRecorded: true });
    }

    // 3b) insert (adjust fields when you add more columns)
    const { data: ins, error: insErr } = await supa()
      .from('contributions')
      .insert({ tx_hash: tx })
      .select('id')
      .maybeSingle();

    if (insErr) {
      // If you later add a unique index, a race can throw 23505; handle here
      const msg = String(insErr.message || '');
      const code = (insErr as any).code || '';
      if (code === '23505' || /duplicate key|unique/i.test(msg)) {
        return json(200, { ok: true, inserted: null, alreadyRecorded: true });
      }
      return json(400, { ok: false, error: msg || 'db_error' });
    }

    return json(200, { ok: true, inserted: ins ?? null, alreadyRecorded: false });
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message || 'db_exception' });
  }
}

