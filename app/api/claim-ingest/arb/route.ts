// app/api/claim-ingest/arb/route.ts
// Arbitrum One claim-ingest aligned to stable ETH/AVAX model
// Tables:
// - contributions: wallet_id, tx_hash, amount, amount_usd, block_time, priced_at, note
// - wallets: id, address, chain
// Mapping: wallets.address == tx.to (case-insensitive) AND chain == 'arb'
// Response: { ok, code, message, data? }
// Idempotent on tx_hash; stores optional "note"

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;

const CRON_SECRET = process.env.CRON_SECRET || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';
const ARB_RPC_URL = process.env.ARB_RPC_URL || '';

function json(status: number, payload: J) {
  return NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });
}
function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- utils ----------
const normalizeTxHash = (tx: string) => {
  const t = String(tx || '').trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return ('0x' + t).toLowerCase();
  return t;
};
const isEvmHash = (tx: string) => /^0x[0-9a-fA-F]{64}$/.test(tx);
const strip0x = (s: string) => (s?.startsWith('0x') ? s.slice(2) : s);
const lowerNo0x = (s: string) => strip0x(String(s || '')).toLowerCase();

function hexToBigInt(hex: string): bigint {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + (clean || '0'));
}
function hexToNumber(hex: string): number { return Number(hexToBigInt(hex)); }
function weiToEthString(weiHexOrDec: string): string {
  const wei = weiHexOrDec?.startsWith?.('0x') ? hexToBigInt(weiHexOrDec) : BigInt(weiHexOrDec || '0');
  const ether = wei / 10n ** 18n;
  const remainder = wei % 10n ** 18n;
  const rest = remainder.toString().padStart(18, '0').replace(/0+$/, '');
  return rest ? `${ether.toString()}.${rest}` : ether.toString();
}

// ---------- RPC ----------
async function rpc(method: string, params: any[]) {
  if (!ARB_RPC_URL) return { ok: false as const, error: 'missing_arb_rpc_url' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (NOWNODES_API_KEY) { headers['api-key'] = NOWNODES_API_KEY; headers['x-api-key'] = NOWNODES_API_KEY; }
    const res = await fetch(ARB_RPC_URL, { method: 'POST', headers, body, cache: 'no-store' });
    const txt = await res.text();
    let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!res.ok) return { ok: false as const, error: `rpc_http_${res.status}:${txt || 'no_body'}` };
    if (j?.error) return { ok: false as const, error: `rpc_${j.error?.code}:${j.error?.message}` };
    return { ok: true as const, result: j?.result };
  } catch (e: any) {
    return { ok: false as const, error: `rpc_network:${e?.message || 'unknown'}` };
  }
}
const getReceipt = (h: string) => rpc('eth_getTransactionReceipt', [h]);
const getTx      = (h: string) => rpc('eth_getTransactionByHash', [h]);
const getBlock   = (n: string) => rpc('eth_getBlockByNumber', [n, false]);

// ---------- USD pricing (best-effort) ----------
async function priceEthToUsdOrNull(amountEthStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const fns = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter(k => typeof fx[k] === 'function');
    if (!fns.length) return null;
    const getPrices = fx[fns[0]].bind(fx);
    // ETH-based best-effort (kept identical to ETH route model)
    const prices: Record<string, number> = await getPrices(['ETH']);
    const usd = prices?.ETH ?? prices?.eth;
    const eth = parseFloat(amountEthStr || '0');
    if (typeof usd !== 'number' || !Number.isFinite(eth)) return null;
    return { usd: +(eth * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// ---------- DB helpers ----------
async function findArbWalletIdByToAddress(addr: string): Promise<string | null> {
  const addrLower = String(addr || '').toLowerCase();
  const addrNo0x = lowerNo0x(addrLower);
  const sel = 'id,address,chain';

  { const { data } = await supa().from('wallets').select(sel).eq('chain','arb').eq('address', addrLower).limit(1);
    if (data && data.length) return String(data[0].id); }
  { const { data } = await supa().from('wallets').select(sel).eq('chain','arb').ilike('address', addrLower).limit(1);
    if (data && data.length) return String(data[0].id); }
  { const { data } = await supa().from('wallets').select(sel).eq('chain','arb')
      .or(`address.eq.${addrNo0x},address.ilike.${addrNo0x}`).limit(1);
    if (data && data.length) return String(data[0].id); }

  return null;
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok: false, code: 'unauthorized', message: 'Unauthorized.' });
  }

  // input
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({} as any));
  let tx = (url.searchParams.get('tx') || body?.txHash || body?.tx_hash || body?.hash || '').trim();
  const noteRaw = (typeof body?.note === 'string' ? body.note : (typeof body?.message === 'string' ? body.message : '')) || '';
  const note = noteRaw.toString().trim() || null;

  if (!tx) return json(400, { ok: false, code: 'invalid_payload', message: 'Invalid transaction hash format.' });
  tx = normalizeTxHash(tx);
  if (!isEvmHash(tx)) return json(400, { ok: false, code: 'invalid_payload', message: 'Invalid transaction hash format.' });

  // on-chain
  const [rr, tr] = await Promise.all([ getReceipt(tx), getTx(tx) ]);
  if (!rr.ok || !tr.ok) return json(502, { ok: false, code: 'rpc_error', message: 'An error occurred while fetching the transaction.' });

  const receipt = rr.result;
  const txObj = tr.result;
  if (!txObj) {
    return json(200, { ok: false, code: 'tx_not_found', message: 'The hash of this transaction does not exist on the blockchain.', data: { txHash: tx } });
  }
  if (!receipt?.blockNumber) {
    return json(200, { ok: false, code: 'rpc_error', message: 'Transaction is not yet confirmed on-chain.', data: { txHash: tx } });
  }

  const br = await getBlock(String(receipt.blockNumber));
  if (!br.ok) return json(502, { ok: false, code: 'rpc_error', message: 'Unable to fetch block information.' });
  const tsSec = br.result?.timestamp ? hexToNumber(String(br.result.timestamp)) : null;
  if (!tsSec) return json(502, { ok: false, code: 'rpc_error', message: 'Unable to fetch block information.' });
  const blockTimeISO = new Date(tsSec * 1000).toISOString();

  const amountEthStr = weiToEthString(String(txObj.value ?? '0x0'));
  const toAddress = String(txObj.to || '').toLowerCase();

  // idempotent pre-check
  {
    const { data: found } = await supa().from('contributions').select('id').eq('tx_hash', tx).limit(1);
    if (found && found.length) {
      return json(200, { ok: true, code: 'duplicate', message: 'The transaction has already been recorded in our project before.', data: { txHash: tx } });
    }
  }

  const wallet_id = toAddress ? await findArbWalletIdByToAddress(toAddress) : null;
  if (!wallet_id) {
    return json(200, { ok: false, code: 'not_project_wallet', message: 'The transaction is not directed to our project. The wallet address does not belong to this project.', data: { txHash: tx } });
  }

  const priced = await priceEthToUsdOrNull(amountEthStr);
  const payload: Record<string, any> = { wallet_id, tx_hash: tx, amount: amountEthStr, block_time: blockTimeISO };
  if (priced) { payload.amount_usd = priced.usd; payload.priced_at = priced.pricedAt; }
  if (note) payload.note = note;

  const { data: ins, error: insErr } = await supa().from('contributions').insert(payload).select('id').maybeSingle();
  if (insErr) {
    const msg = String(insErr.message || ''); const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json(200, { ok: true, code: 'duplicate', message: 'The transaction has already been recorded in our project before.', data: { txHash: tx } });
    }
    return json(400, { ok: false, code: 'db_error', message: 'Database write error.' });
  }

  return json(200, { ok: true, code: 'inserted', message: 'The transaction was successfully recorded on our project.', data: { txHash: tx, inserted: ins ?? null } });
}

