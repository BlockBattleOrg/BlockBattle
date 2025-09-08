// app/api/claim-ingest/xlm/route.ts
// Stellar (XLM) claim-ingest via Horizon

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;

const CRON_SECRET = process.env.CRON_SECRET || '';
const XLM_HORIZON_URL = process.env.XLM_HORIZON_URL || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';

const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

const normalizeHash = (s: string) => String(s || '').trim();
const is64hex = (s: string) => /^[0-9A-Fa-f]{64}$/.test(s);

async function priceToUsdOrNullXLM(amountStr: string): Promise<{ usd:number; pricedAt:string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter(k => typeof (fx as any)[k] === 'function');
    if (!fns.length) return null;
    const getPrices = (fx as any)[fns[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['XLM']);
    const usd = prices?.XLM ?? prices?.xlm;
    const amt = parseFloat(amountStr || '0');
    if (typeof usd !== 'number' || !Number.isFinite(amt)) return null;
    return { usd: +(amt * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

async function findXlmWalletId(addr: string): Promise<string | null> {
  const { data } = await supa().from('wallets').select('id,address,chain').eq('chain','xlm').eq('address', addr).limit(1);
  return data && data.length ? String(data[0].id) : null;
}

export async function POST(req: NextRequest) {
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) return json(401, { ok:false, code:'unauthorized', message:'Unauthorized.' });

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  let tx = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  if (!tx) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });
  tx = normalizeHash(tx);
  if (!is64hex(tx)) return json(400, { ok:false, code:'invalid_payload', message:'Invalid transaction hash format.' });

  // idempotent
  {
    const { data: found } = await supa().from('contributions').select('id').eq('tx_hash', tx).limit(1);
    if (found && found.length) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash: tx } });
    }
  }

  if (!XLM_HORIZON_URL) {
    return json(502, { ok:false, code:'rpc_error', message:'XLM Horizon URL is not configured.' });
  }

  // Prepare headers (NowNodes requires API key on Horizon too)
  const headers: Record<string, string> = { 'accept': 'application/json' };
  if (NOWNODES_API_KEY) { headers['api-key'] = NOWNODES_API_KEY; headers['x-api-key'] = NOWNODES_API_KEY; }

  // Fetch transaction
  const txRes = await fetch(`${XLM_HORIZON_URL}/transactions/${tx}`, { cache: 'no-store', headers });
  if (txRes.status === 404) {
    return json(200, { ok:false, code:'tx_not_found', message:'The hash of this transaction does not exist on the blockchain.', data:{ txHash: tx } });
  }
  if (!txRes.ok) {
    return json(502, { ok:false, code:'rpc_error', message:'An error occurred while fetching the transaction.' });
  }
  const txJson: any = await txRes.json().catch(() => null);
  const successful = Boolean(txJson?.successful);
  if (!successful) {
    return json(200, { ok:false, code:'rpc_error', message:'Transaction is not yet confirmed on-chain.', data:{ txHash: tx } });
  }

  const blockTimeISO = String(txJson?.closed_at || txJson?.created_at || new Date().toISOString());

  // Fetch operations to find payments to our wallets
  const opsRes = await fetch(`${XLM_HORIZON_URL}/transactions/${tx}/operations?limit=200`, { cache: 'no-store', headers });
  if (!opsRes.ok) {
    return json(502, { ok:false, code:'rpc_error', message:'Unable to fetch transaction operations.' });
  }
  const opsJson: any = await opsRes.json().catch(() => null);
  const records: any[] = Array.isArray(opsJson?._embedded?.records) ? opsJson._embedded.records : [];

  let totalXlm = 0;
  let wallet_id: string | null = null;

  for (const op of records) {
    if (op?.type === 'payment' && op?.asset_type === 'native' && typeof op?.to === 'string' && typeof op?.amount === 'string') {
      const wid = await findXlmWalletId(op.to);
      if (wid) {
        totalXlm += parseFloat(op.amount || '0');
        if (!wallet_id) wallet_id = wid;
      }
    }
  }

  if (!(totalXlm > 0) || !wallet_id) {
    return json(200, { ok:false, code:'not_project_wallet', message:'The transaction is not directed to our project. The wallet address does not belong to this project.', data:{ txHash: tx } });
  }

  const amountStr = totalXlm.toString().replace(/\.?0+$/, '');
  const priced = await priceToUsdOrNullXLM(amountStr);

  const payload: Record<string, any> = {
    wallet_id,
    tx_hash: tx,
    amount: amountStr,
    block_time: blockTimeISO,
  };
  if (priced) { payload.amount_usd = priced.usd; payload.priced_at = priced.pricedAt; }
  if (note) payload.note = note;

  const { data: ins, error: insErr } = await supa().from('contributions').insert(payload).select('id').maybeSingle();
  if (insErr) {
    const msg = String(insErr.message || ''); const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json(200, { ok:true, code:'duplicate', message:'The transaction has already been recorded in our project before.', data:{ txHash: tx } });
    }
    return json(400, { ok:false, code:'db_error', message:'Database write error.' });
  }

  return json(200, { ok:true, code:'inserted', message:'The transaction was successfully recorded on our project.', data:{ txHash: tx, inserted: ins ?? null } });
}

