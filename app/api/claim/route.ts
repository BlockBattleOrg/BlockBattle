// app/api/claim/route.ts
// Public claim proxy.
// Accepts { chain, tx, message, hcaptchaToken? } from the UI and forwards
// to the appropriate internal claim-ingest route, mapping `message` -> `note`.
//
// Behavior:
// - Validates EVM hash format for EVM chains only (ETH, ARB, AVAX, OP, POL, BSC).
// - Forwards to /api/claim-ingest/<chain> with x-cron-secret and JSON body.
// - If the inner route returns JSON, proxy returns it verbatim (status 200).
// - If the inner route does not exist (404) or returns non-JSON, proxy returns:
//     { ok:false, code:"unsupported_chain", message:"Selected chain is not yet supported." }
// - For other fetch failures: { ok:false, code:"rpc_error", message:"Request failed." }

import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CRON_SECRET = process.env.CRON_SECRET || '';

const EVM_CHAINS = new Set(['eth', 'arb', 'avax', 'op', 'pol', 'bsc']);
const ALL_CHAINS = new Set([
  'eth',  // Ethereum
  'arb',  // Arbitrum
  'avax', // Avalanche
  'op',   // Optimism
  'pol',  // Polygon
  'dot',  // Polkadot
  'btc',  // Bitcoin
  'ltc',  // Litecoin
  'doge', // Dogecoin
  'xrp',  // XRP
  'xlm',  // Stellar
  'sol',  // Solana
  'trx',  // Tron
  'bsc',  // BNB Smart Chain
  'atom', // Cosmos
]);

const isEvmHash = (s: unknown): s is string =>
  typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s || '');

function bad(message: string, code = 'invalid_payload') {
  return NextResponse.json(
    { ok: false, code, message },
    { status: 200, headers: { 'cache-control': 'no-store' } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({} as any));
    const chain = String(body?.chain || '').trim().toLowerCase();
    const tx = String(body?.tx || '').trim();
    const message = typeof body?.message === 'string' ? body.message.trim() : '';

    if (!chain || !tx) {
      return bad('Invalid transaction hash format.');
    }
    if (!ALL_CHAINS.has(chain)) {
      return NextResponse.json(
        { ok: false, code: 'unsupported_chain', message: 'Selected chain is not yet supported.' },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }

    // Minimal local validation for EVM chains only
    if (EVM_CHAINS.has(chain) && !isEvmHash(tx)) {
      return bad('Hash format is not correct.', 'invalid_payload');
    }

    // Map chain -> inner path (we include all; if some are not implemented yet, we translate 404 to unsupported_chain)
    const innerPath = `/api/claim-ingest/${chain}`;

    const url = new URL(innerPath, req.nextUrl.origin);
    // keep compatibility with inner routes that also read ?tx=
    url.searchParams.set('tx', tx);

    const forward = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-cron-secret': CRON_SECRET,
      },
      body: JSON.stringify({
        txHash: tx,
        note: message || undefined,    // ensure note is forwarded to be stored
        message: message || undefined, // backward-compat if inner route reads 'message'
      }),
      cache: 'no-store',
    });

    // If inner route is missing (404) or not JSON -> present a clean unsupported message
    if (!forward.ok) {
      if (forward.status === 404) {
        return NextResponse.json(
          { ok: false, code: 'unsupported_chain', message: 'Selected chain is not yet supported.' },
          { status: 200, headers: { 'cache-control': 'no-store' } },
        );
      }
      return NextResponse.json(
        { ok: false, code: 'rpc_error', message: 'Request failed.' },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }

    let payload: any = null;
    try {
      payload = await forward.json();
    } catch {
      // Non-JSON from inner route
      return NextResponse.json(
        { ok: false, code: 'unsupported_chain', message: 'Selected chain is not yet supported.' },
        { status: 200, headers: { 'cache-control': 'no-store' } },
      );
    }

    // Pass-through JSON (new or legacy shapes; UI normalizes)
    return NextResponse.json(
      payload,
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  } catch {
    return NextResponse.json(
      { ok: false, code: 'rpc_error', message: 'Request failed.' },
      { status: 200, headers: { 'cache-control': 'no-store' } },
    );
  }
}

