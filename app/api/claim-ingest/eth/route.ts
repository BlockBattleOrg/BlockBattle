// app/api/claim-ingest/eth/route.ts
// ETH claim-ingest aligned to repo schema:
// - contributions: wallet_id, tx_hash, amount, amount_usd, block_time, priced_at
// - wallets: id, address, chain
// Mapping rule: wallet = wallets.address == tx.to (case-insensitive) AND chain == 'eth'
// USD pricing: best-effort via lib/fx (if available)
// Idempotent: skip if tx_hash already exists

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;

const CRON_SECRET = process.env.CRON_SECRET || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';
const ETH_RPC_URL =
  process.env.ETH_RPC_URL ||
  process.env.EVM_RPC_URL ||
  'https://eth.nownodes.io';

function json(status: number, payload: J) {
  return NextResponse.json(payload, { status });
}
function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- utils ----------
const normalizeTxHash = (tx: string) => {
  const t = tx.trim();
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
function hexToNumber(hex: string): number {
  return Number(hexToBigInt(hex));
}
function weiToEthString(weiHexOrDec: string): string {
  const wei = weiHexOrDec.startsWith('0x') ? hexToBigInt(weiHexOrDec) : BigInt(weiHexOrDec);
  const ether = wei / 10n ** 18n;
  const remainder = wei % 10n ** 18n;
  const rest = remainder.toString().padStart(18, '0').replace(/0+$/, '');
  return rest ? `${ether.toString()}.${rest}` : ether.toString();
}

// ---------- RPC ----------
async function rpc(method: string, params: any[]) {
  if (!ETH_RPC_URL) return { ok: false as const, error: 'missing_eth_rpc_url' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (NOWNODES_API_KEY) {
      headers['api-key'] = NOWNODES_API_KEY;
      headers['x-api-key'] = NOWNODES_API_KEY;
    }
    const res = await fetch(ETH_RPC_URL, { method: 'POST', headers, body });
    const txt = await res.text();
    let j: any = null;
    try { j = txt ? JSON.parse(txt) : null; } catch {}
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
    const names = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter((k) => typeof fx[k] === 'function');
    if (!names.length) return null;
    const getPrices = fx[names[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['ETH']);
    const usd = prices?.ETH ?? prices?.eth;
    if (typeof usd !== 'number') return null;
    const eth = parseFloat(amountEthStr || '0');
    if (!Number.isFinite(eth)) return null;
    return { usd: +(eth * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// ---------- DB helpers ----------
async function findEthWalletIdByToAddress(addr: string): Promise<string | null> {
  // tražimo wallet gdje address matcha i chain=='eth'
  // pokrivamo i varijantu bez '0x'
  const addrLower = addr.toLowerCase();
  const addrNo0x = lowerNo0x(addr);
  const sel = 'id,address,chain';

  // 1) eq + chain
  let q: any = supa().from('wallets').select(sel).eq('chain', 'eth').eq('address', addrLower).limit(1);
  let { data, error } = await q;
  if (!error && data && data.length) return String(data[0].id);

  // 2) ilike + chain
  q = supa().from('wallets').select(sel).eq('chain', 'eth').ilike('address', addrLower).limit(1);
  ({ data, error } = await q);
  if (!error && data && data.length) return String(data[0].id);

  // 3) bez 0x + chain
  q = supa().from('wallets').select(sel).eq('chain', 'eth')
        .or(`address.eq.${addrNo0x},address.ilike.${addrNo0x}`).limit(1);
  ({ data, error } = await q);
  if (!error && data && data.length) return String(data[0].id);

  return null;
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  // input
  const url = new URL(req.url);
  let tx = (url.searchParams.get('tx') || '').trim();
  if (!tx) return json(400, { ok: false, error: 'missing_tx' });
  tx = normalizeTxHash(tx);
  if (!isEvmHash(tx)) return json(400, { ok: false, error: 'invalid_tx_format' });

  // on-chain
  const r = await getReceipt(tx);
  if (!r.ok) return json(502, { ok: false, error: r.error });
  const receipt = r.result;
  if (!receipt?.blockNumber) return json(409, { ok: false, error: 'tx_pending' });

  const [tr, br] = await Promise.all([ getTx(tx), getBlock(receipt.blockNumber) ]);
  if (!tr.ok) return json(502, { ok: false, error: tr.error });
  if (!br.ok) return json(502, { ok: false, error: br.error });

  const txObj = tr.result;
  if (!txObj) return json(404, { ok: false, error: 'tx_not_found' });

  const tsSec = br.result?.timestamp ? hexToNumber(String(br.result.timestamp)) : null;
  if (!tsSec) return json(502, { ok: false, error: 'block_timestamp_unavailable' });
  const blockTimeISO = new Date(tsSec * 1000).toISOString();

  const amountEthStr = weiToEthString(String(txObj.value ?? '0x0'));
  const toAddress = String(txObj.to || '').toLowerCase();

  // idempotent pre-check
  const { data: found, error: qErr } = await supa()
    .from('contributions')
    .select('id')
    .eq('tx_hash', tx)
    .limit(1);
  if (!qErr && found && found.length) {
    return json(200, { ok: true, inserted: null, alreadyRecorded: true });
  }

  // map wallet_id by address + chain='eth'
  let wallet_id: string | null = null;
  if (toAddress) wallet_id = await findEthWalletIdByToAddress(toAddress);

  // best-effort USD pricing
  const priced = await priceEthToUsdOrNull(amountEthStr);

  // payload strictly per schema
  const payload: Record<string, any> = {
    tx_hash: tx,
    amount: amountEthStr,
    block_time: blockTimeISO,
  };
  if (wallet_id) payload.wallet_id = wallet_id;
  if (priced) {
    payload.amount_usd = priced.usd;
    payload.priced_at = priced.pricedAt;
  }

  const { data: ins, error: insErr } = await supa()
    .from('contributions')
    .insert(payload)
    .select('id')
    .maybeSingle();

  if (insErr) {
    const msg = String(insErr.message || '');
    const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json(200, { ok: true, inserted: null, alreadyRecorded: true });
    }
    return json(400, { ok: false, error: msg || 'db_error' });
  }

  return json(200, { ok: true, inserted: ins ?? null, alreadyRecorded: false });
}

