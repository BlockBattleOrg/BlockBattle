// app/api/claim-ingest/atom/route.ts
// Cosmos (ATOM) claim-ingest via Cosmos REST (NowNodes).
// Scope: bank.MsgSend native ATOM (uatom) transfers to our wallets.
// Tables:
//  - wallets: id, address, chain ('atom')
//  - contributions: wallet_id, tx_hash, amount, amount_usd, block_time, priced_at, note
//
// ENV used: ATOM_REST_URL, NOWNODES_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;

const CRON_SECRET = process.env.CRON_SECRET || '';
const ATOM_REST_URL = process.env.ATOM_REST_URL || process.env.ATOM_RPC_URL || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';

const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- utils ----------
const normalizeTxHash64 = (s: string) => String(s || '').trim();
const is64hex = (s: string) => /^[0-9A-Fa-f]{64}$/.test(s);

// uatom -> ATOM (1 ATOM = 1e6 uatom)
function uatomToAtomString(u: string | number | bigint): string {
  const bn = typeof u === 'bigint' ? u : BigInt(String(u || '0'));
  const whole = bn / 1_000_000n;
  const frac  = bn % 1_000_000n;
  const rest = frac.toString().padStart(6, '0').replace(/0+$/, '');
  return rest ? `${whole.toString()}.${rest}` : whole.toString();
}

async function priceToUsdOrNullATOM(amountStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter(k => typeof (fx as any)[k] === 'function');
    if (!fns.length) return null;
    const getPrices = (fx as any)[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['ATOM']);
    const usd = prices?.ATOM ?? prices?.atom;
    const amt = parseFloat(amountStr || '0');
    if (typeof usd !== 'number' || !Number.isFinite(amt)) return null;
    return { usd: +(amt * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// ---------- db ----------
async function findAtomWalletId(addr: string): Promise<string | null> {
  const { data } = await supa()
    .from('wallets')
    .select('id,address,chain')
    .eq('chain', 'atom')
    .eq('address', addr)
    .limit(1);
  return data && data.length ? String(data[0].id) : null;
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok:false, code:'unauthorized', message:'Unauthorized.' });
  }
  if (!ATOM_REST_URL) {
    return json(502, { ok:false, code:'rpc_error', message:'ATOM REST URL is not configured.' });
  }

  // input (?tx + JSON body { txHash, note })
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  let txHash = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  if (!txHash) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });
  txHash = normalizeTxHash64(txHash);
  if (!is64hex(txHash)) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });

  // idempotent pre-check
  {
    const { data: found } = await supa().from('contributions').select('id').eq('tx_hash', txHash).limit(1);
    if (found && found.length) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash } });
    }
  }

  // fetch tx via Cosmos REST: /cosmos/tx/v1beta1/txs/{hash}
  const headers: Record<string,string> = { accept: 'application/json' };
  if (NOWNODES_API_KEY) { headers['api-key'] = NOWNODES_API_KEY; headers['x-api-key'] = NOWNODES_API_KEY; }

  const res = await fetch(`${ATOM_REST_URL.replace(/\/+$/,'')}/cosmos/tx/v1beta1/txs/${txHash}`, {
    headers, cache: 'no-store',
  });

  if (res.status === 404) {
    return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash } });
  }
  if (!res.ok) {
    return json(502, { ok:false, code:'rpc_error', message:'An error occurred while fetching the transaction.' });
  }

  const j: any = await res.json().catch(() => null);
  const txr = j?.tx_response;
  if (!txr) {
    return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash } });
  }

  // success criteria: code === 0 and height > 0
  const success = Number(txr.code) === 0 && Number(txr.height) > 0;
  if (!success) {
    return json(200, { ok:false, code:'rpc_error', message:'Transaction is not yet confirmed on-chain.', data:{ txHash } });
  }

  const blockTimeISO = typeof txr.timestamp === 'string' ? txr.timestamp : new Date().toISOString();

  // Extract MsgSend to our wallets, denom uatom
  const msgs: any[] = j?.tx?.body?.messages || [];
  let totalUatom = 0n;
  let wallet_id: string | null = null;

  for (const m of msgs) {
    const t = String(m?.['@type'] || m?.type || '');
    if (t.endsWith('MsgSend')) {
      const to = String(m?.to_address || '');
      const amounts: any[] = Array.isArray(m?.amount) ? m.amount : [];
      const uatom = amounts.find(a => a?.denom === 'uatom');
      if (uatom && typeof uatom?.amount === 'string') {
        const wid = await findAtomWalletId(to);
        if (wid) {
          totalUatom += BigInt(uatom.amount);
          if (!wallet_id) wallet_id = wid;
        }
      }
    }
  }

  if (totalUatom <= 0n || !wallet_id) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash } });
  }

  const amountAtomStr = uatomToAtomString(totalUatom);
  const priced = await priceToUsdOrNullATOM(amountAtomStr);

  const payload: Record<string, any> = {
    wallet_id,
    tx_hash: txHash,
    amount: amountAtomStr,
    block_time: blockTimeISO,
  };
  if (priced) { payload.amount_usd = priced.usd; payload.priced_at = priced.pricedAt; }
  if (note) payload.note = note;

  const { data: ins, error: insErr } = await supa().from('contributions').insert(payload).select('id').maybeSingle();
  if (insErr) {
    const msg = String(insErr.message || ''); const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash } });
    }
    return json(400, { ok:false, code:'db_error', message:'Database write error.' });
  }

  return json(200, { ok:true, code:'inserted', message:'The transaction was successfully recorded on our project.', data:{ txHash, inserted: ins ?? null } });
}

