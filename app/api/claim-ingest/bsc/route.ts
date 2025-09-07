// app/api/claim-ingest/bsc/route.ts
// BNB Smart Chain claim-ingest, chain='bsc' with soft RPC fallback
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type J = Record<string, unknown>;
const CRON_SECRET = process.env.CRON_SECRET || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';
const PRIMARY_RPC = process.env.BSC_RPC_URL || '';
const FALLBACK_RPC = process.env.BSC_RPC_URL_FALLBACK || ''; // optional, e.g. https://bsc-dataseed.binance.org
const EXPECTED_CHAIN_ID_HEX = '0x38'; // 56 (BSC mainnet)

const json = (status: number, payload: J) =>
  NextResponse.json(payload, { status, headers: { 'cache-control': 'no-store' } });
const json200 = (payload: J) => json(200, payload);

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

const hexToBigInt = (hex: string) => {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + (clean || ''));
};
const hexToNumber = (hex: string) => Number(hexToBigInt(hex));
const weiToEthString = (weiHexOrDec: string) => {
  const wei = weiHexOrDec.startsWith('0x') ? hexToBigInt(weiHexOrDec) : BigInt(weiHexOrDec);
  const ether = wei / 10n ** 18n;
  const remainder = wei % 10n ** 18n;
  const rest = remainder.toString().padStart(18, '0').replace(/0+$/, '');
  return rest ? `${ether.toString()}.${rest}` : ether.toString();
};

// ---------- RPC ----------
type RpcRes<T=any> = { ok: true; result: T } | { ok: false; error: string };

async function rpcOnce(url: string, method: string, params: any[]): Promise<RpcRes> {
  if (!url) return { ok: false as const, error: 'missing_rpc_url' };
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // harmless on non-NowNodes endpoints
    if (NOWNODES_API_KEY) { headers['api-key'] = NOWNODES_API_KEY; headers['x-api-key'] = NOWNODES_API_KEY; }
    const res = await fetch(url, { method: 'POST', headers, body, cache: 'no-store' });
    const txt = await res.text();
    let j: any = null; try { j = txt ? JSON.parse(txt) : null; } catch {}
    if (!res.ok) return { ok: false as const, error: `rpc_http_${res.status}:${txt || 'no_body'}` };
    if (j?.error) return { ok: false as const, error: `rpc_${j.error?.code}:${j.error?.message}` };
    return { ok: true as const, result: j?.result };
  } catch (e: any) {
    return { ok: false as const, error: `rpc_network:${e?.message || 'unknown'}` };
  }
}

async function rpc(method: string, params: any[]) {
  // try primary
  const first = await rpcOnce(PRIMARY_RPC, method, params);
  if (first.ok) return first;
  // if primary has hard error and we have fallback, try fallback
  if (FALLBACK_RPC) {
    const second = await rpcOnce(FALLBACK_RPC, method, params);
    if (second.ok) return second;
  }
  return first;
}

const chainId   = () => rpc('eth_chainId', []);
const getTx     = (h: string) => rpc('eth_getTransactionByHash', [h]);
const getReceipt= (h: string) => rpc('eth_getTransactionReceipt', [h]);
const getBlock  = (n: string) => rpc('eth_getBlockByNumber', [n, false]);
const getTxByBlockAndIndex = (blockHash: string, txIndexHex: string) =>
  rpc('eth_getTransactionByBlockHashAndIndex', [blockHash, txIndexHex]);

// ---------- USD pricing ----------
async function priceEthToUsdOrNull(amountEthStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const names = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter((k) => typeof (fx as any)[k] === 'function');
    if (!names.length) return null;
    const getPrices = (fx as any)[names[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['ETH']);
    const usd = prices?.ETH ?? prices?.eth;
    if (typeof usd !== 'number') return null;
    const eth = parseFloat(amountEthStr || '0');
    if (!Number.isFinite(eth)) return null;
    return { usd: +(eth * usd).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// ---------- DB helpers ----------
async function findBscWalletIdByToAddress(addr: string): Promise<string | null> {
  const addrLower = addr.toLowerCase();
  const addrNo0x = lowerNo0x(addr);
  const sel = 'id,address,chain';

  { const { data } = await supa().from('wallets').select(sel).eq('chain','bsc').eq('address', addrLower).limit(1);
    if (data && data.length) return String(data[0].id); }
  { const { data } = await supa().from('wallets').select(sel).eq('chain','bsc').ilike('address', addrLower).limit(1);
    if (data && data.length) return String(data[0].id); }
  { const { data } = await supa().from('wallets').select(sel).eq('chain','bsc')
      .or(`address.eq.${addrNo0x},address.ilike.${addrNo0x}`).limit(1);
    if (data && data.length) return String(data[0].id); }

  return null;
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) return json(401, { ok: false, error: 'unauthorized' });

  // sanity: chain id
  const id = await chainId();
  if (!id.ok || String(id.result).toLowerCase() !== EXPECTED_CHAIN_ID_HEX) {
    return json(500, { ok: false, code: 'rpc_chain_mismatch', message: 'RPC endpoint is not a BNB Smart Chain node.' });
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

  // fetch tx & receipt (primary, possibly fallback)
  const [tr, rr] = await Promise.all([ getTx(tx), getReceipt(tx) ]);
  if (!tr.ok || !rr.ok) return json(502, { ok: false, code: 'rpc_error', message: 'An error occurred while fetching the transaction.' });

  let txObj: any = tr.result;
  const receipt: any = rr.result;

  // If both null, try hard-fallback only when we have an explicit fallback URL.
  if (!txObj && !receipt && FALLBACK_RPC) {
    const [tr2, rr2] = await Promise.all([
      rpcOnce(FALLBACK_RPC, 'eth_getTransactionByHash', [tx]),
      rpcOnce(FALLBACK_RPC, 'eth_getTransactionReceipt', [tx]),
    ]);
    txObj = tr2.ok ? tr2.result : null;
    const rc2 = rr2.ok ? rr2.result : null;
    if (!receipt && rc2) (Object as any).assign((rr as any), { result: rc2 }); // keep same var name
  }

  if (!txObj && !receipt) {
    return json200({ ok: false, code: 'tx_not_found', message: 'The hash of this transaction does not exist on the blockchain.', data: { txHash: tx } });
  }
  if (receipt && !receipt.blockNumber) {
    return json200({ ok: false, code: 'rpc_error', message: 'Transaction is not yet confirmed on-chain.', data: { txHash: tx } });
  }

  // If getTransactionByHash is null but we have receipt, reconstruct tx via block/index
  if (!txObj && receipt?.blockHash && typeof receipt?.transactionIndex === 'string') {
    const byIdx = await getTxByBlockAndIndex(String(receipt.blockHash), String(receipt.transactionIndex));
    if (byIdx.ok) txObj = (byIdx as any).result;
  }

  // need block time
  const br = await getBlock(String(receipt.blockNumber));
  if (!br.ok) return json(502, { ok: false, code: 'rpc_error', message: 'Unable to fetch block information.' });
  const tsSec = br.result?.timestamp ? hexToNumber(String(br.result.timestamp)) : null;
  if (!tsSec) return json(502, { ok: false, code: 'rpc_error', message: 'Unable to fetch block information.' });
  const blockTimeISO = new Date(tsSec * 1000).toISOString();

  const amountEthStr = txObj ? weiToEthString(String(txObj.value ?? '0x0')) : '0';
  const toAddress = txObj ? String(txObj.to || '').toLowerCase() : (receipt?.to ? String(receipt.to).toLowerCase() : '');

  // idempotent pre-check
  {
    const { data: found, error: qErr } = await supa().from('contributions').select('id').eq('tx_hash', tx).limit(1);
    if (!qErr && found && found.length) {
      return json200({ ok: true, code: 'duplicate', message: 'The transaction has already been recorded in our project before.', data: { txHash: tx } });
    }
  }

  const wallet_id = toAddress ? await findBscWalletIdByToAddress(toAddress) : null;
  if (!wallet_id) {
    return json200({ ok: false, code: 'not_project_wallet', message: 'The transaction is not directed to our project. The wallet address does not belong to this project.', data: { txHash: tx } });
  }

  const priced = await priceEthToUsdOrNull(amountEthStr);
  const payload: Record<string, any> = { wallet_id, tx_hash: tx, amount: amountEthStr, block_time: blockTimeISO, note };
  if (priced) { payload.amount_usd = priced.usd; payload.priced_at = priced.pricedAt; }

  const { data: ins, error: insErr } = await supa().from('contributions').insert(payload).select('id').maybeSingle();
  if (insErr) {
    const msg = String(insErr.message || ''); const code = (insErr as any).code || '';
    if (code === '23505' || /duplicate key|unique/i.test(msg)) {
      return json200({ ok: true, code: 'duplicate', message: 'The transaction has already been recorded in our project before.', data: { txHash: tx } });
    }
    return json(400, { ok: false, code: 'db_error', message: 'Database write error.' });
  }

  return json200({ ok: true, code: 'inserted', message: 'The transaction was successfully recorded on our project.', data: { txHash: tx, inserted: ins ?? null } });
}

