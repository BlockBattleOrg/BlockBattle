// app/api/claim-ingest/eth/route.ts
// ETH claim-ingest (schema-aware, ETH-first wallet resolution with scoring)
// - Auth: x-cron-secret
// - Verify: receipt confirmed, tx (value/from/to), block (timestamp)
// - Insert ONLY columns that exist (info_schema when available; ultra-minimal fallback otherwise)
// - wallet_id resolution: fetch all wallet rows for address, score by ETH hints (network/chain/symbol/asset), pick best if confident
// - amount_usd/priced_at only if columns exist
// - Idempotent insert

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Json = Record<string, unknown>;

const CRON_SECRET = process.env.CRON_SECRET || '';
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || '';
const ETH_RPC_URL =
  process.env.ETH_RPC_URL ||
  process.env.EVM_RPC_URL ||
  'https://eth.nownodes.io';

function json(status: number, payload: Json) {
  return NextResponse.json(payload, { status });
}
function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- utils ----------
function normalizeEvm(tx: string) {
  const raw = tx.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return ('0x' + raw).toLowerCase();
  return raw;
}
function isValidEvmHash(tx: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(tx);
}
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
  const remainderStr = remainder.toString().padStart(18, '0').replace(/0+$/, '');
  return remainderStr ? `${ether.toString()}.${remainderStr}` : ether.toString();
}
const strip0x = (s: string) => (s?.startsWith('0x') ? s.slice(2) : s);
const lowerNo0x = (s: string) => strip0x(String(s || '')).toLowerCase();

// ---------- RPC ----------
async function rpcCall(method: string, params: any[]) {
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
const fetchEthReceipt = (h: string) => rpcCall('eth_getTransactionReceipt', [h]);
const fetchEthTx = (h: string) => rpcCall('eth_getTransactionByHash', [h]);
const fetchBlockByNumber = (bnHex: string) => rpcCall('eth_getBlockByNumber', [bnHex, false]);

// ---------- optional USD pricing via lib/fx.ts ----------
async function priceEthToUsdOrNull(amountEthStr: string): Promise<{ usd: number; pricedAt: string } | null> {
  try {
    const fx: any = await import('@/lib/fx');
    const names = ['getUsdPrices','fetchUsdPrices','getPrices','pricesForSymbols'].filter((k) => typeof fx[k] === 'function');
    if (!names.length) return null;
    const getPrices = fx[names[0]].bind(fx);
    const prices: Record<string, number> = await getPrices(['ETH']);
    const usdPrice = prices?.ETH ?? prices?.eth ?? null;
    if (typeof usdPrice !== 'number') return null;
    const eth = parseFloat(amountEthStr || '0');
    if (!Number.isFinite(eth)) return null;
    return { usd: +(eth * usdPrice).toFixed(2), pricedAt: new Date().toISOString() };
  } catch { return null; }
}

// ---------- schema helpers ----------
async function infoSchemaColumns(schema: string, table: string): Promise<Set<string> | null> {
  const { data, error } = await supa()
    .from('information_schema.columns' as any)
    .select('column_name')
    .eq('table_schema', schema as any)
    .eq('table_name', table as any);
  if (!error && Array.isArray(data) && data.length) {
    return new Set((data as any[]).map((r) => r.column_name));
  }
  return null;
}
async function tableHasColumns(table: string, cols: string[]): Promise<Record<string, boolean>> {
  const map: Record<string, boolean> = {};
  try {
    const sel = cols.join(',');
    const { error } = await supa().from(table as any).select(sel).limit(0);
    cols.forEach((c) => (map[c] = !error));
  } catch {
    cols.forEach((c) => (map[c] = false));
  }
  return map;
}
function fallbackContributionCols(): Set<string> {
  // ULTRA-MINIMAL fallback (neće spominjati opcionalne kolone)
  return new Set(['tx_hash','amount','block_time','wallet_id']);
}

// ---------- wallet resolver (ETH-aware scoring) ----------
function scoreWalletRowETH(row: any, addrCol: string): number {
  const v = (s: any) => String(s ?? '').toLowerCase();
  let score = 0;
  // address equality već je uvjet :)
  // prefer ETH mainnet hints:
  if (v(row.network) === 'ethereum') score += 8;
  const ch = v(row.chain);
  if (ch === 'eth' || ch === 'ethereum' || ch === 'eth_mainnet') score += 4;
  const sym = v(row.symbol);
  if (sym === 'eth') score += 2;
  const asset = v(row.asset);
  if (asset === 'eth') score += 1;
  return score;
}
async function resolveWalletIdByAddressETH(toAddr: string): Promise<string | null> {
  const addrLower = toAddr.toLowerCase();
  const addrNo0x  = lowerNo0x(toAddr);

  // detekcija kolona u wallets (ili minimalni set)
  const wcols = (await infoSchemaColumns('public','wallets')) ?? new Set(['id','wallet_id','address','addr','network','symbol','chain','asset']);
  const idCol   = wcols.has('id') ? 'id' : (wcols.has('wallet_id') ? 'wallet_id' : null);
  const addrCol = wcols.has('address') ? 'address' : (wcols.has('addr') ? 'addr' : null);
  if (!idCol || !addrCol) return null;

  // dohvat svih kandidata za tu adresu (eq/ilike i bez 0x)
  const selCols = [idCol, addrCol].concat(['network','chain','symbol','asset'].filter(c => wcols.has(c))).join(', ');

  const queries: any[] = [
    supa().from('wallets').select(selCols).eq(addrCol, addrLower).limit(25),
    supa().from('wallets').select(selCols).ilike(addrCol, addrLower).limit(25),
    supa().from('wallets').select(selCols).or(`${addrCol}.eq.${addrNo0x},${addrCol}.ilike.${addrNo0x}`).limit(25),
  ];

  let candidates: any[] = [];
  for (const q of queries) {
    const { data, error } = await q;
    if (!error && Array.isArray(data) && data.length) {
      candidates = data;
      break;
    }
  }
  if (!candidates.length) return null;

  // rangiraj po ETH hintovima
  let best: { id: string; score: number } | null = null;
  for (const row of candidates) {
    const score = scoreWalletRowETH(row, addrCol);
    const idVal = row[idCol];
    if (idVal == null) continue;
    if (!best || score > best.score) {
      best = { id: String(idVal), score };
    }
  }

  // prag sigurnosti: zahtijevamo barem neki ETH hint; ako 0, radije nemoj mapirati
  if (!best || best.score <= 0) return null;
  return best.id;
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // 0) auth
  const sec = req.headers.get('x-cron-secret') || '';
  if (!CRON_SECRET || sec !== CRON_SECRET) {
    return json(401, { ok: false, error: 'unauthorized' });
  }

  // 1) input
  const url = new URL(req.url);
  let tx = (url.searchParams.get('tx') || '').trim();
  if (!tx) return json(400, { ok: false, error: 'missing_tx' });
  tx = normalizeEvm(tx);
  if (!isValidEvmHash(tx)) return json(400, { ok: false, error: 'invalid_tx_format:expect_0x64_hex' });

  // 2) on-chain data
  const rcp = await fetchEthReceipt(tx);
  if (!rcp.ok) {
    if (rcp.error.includes('notFound')) return json(404, { ok: false, error: 'tx_not_found' });
    return json(502, { ok: false, error: rcp.error || 'rpc_error' });
  }
  const receipt = rcp.result;
  if (!receipt?.blockNumber) return json(409, { ok: false, error: 'tx_pending' });

  const [txr, blkr] = await Promise.all([ fetchEthTx(tx), fetchBlockByNumber(receipt.blockNumber) ]);
  if (!txr.ok) return json(502, { ok: false, error: txr.error || 'rpc_error' });
  const txObj = txr.result;
  if (!txObj) return json(404, { ok: false, error: 'tx_not_found' });

  if (!blkr.ok) return json(502, { ok: false, error: blkr.error || 'rpc_error' });
  const blk = blkr.result;
  const tsSec = blk?.timestamp ? hexToNumber(String(blk.timestamp)) : null;
  const blockTimeISO = tsSec ? new Date(tsSec * 1000).toISOString() : null;

  const amountEthStr = weiToEthString(String(txObj.value ?? '0x0'));
  const toAddress = String(txObj.to || '').toLowerCase();

  // 3) idempotent pre-check
  const { data: found, error: qErr } = await supa()
    .from('contributions')
    .select('id')
    .eq('tx_hash', tx)
    .limit(1);
  if (!qErr && found && found.length) {
    return json(200, { ok: true, inserted: null, alreadyRecorded: true });
  }

  // 4) schema detection (or fallback)
  const infoCols = await infoSchemaColumns('public','contributions');
  const cols = infoCols ?? fallbackContributionCols();

  // 5) payload (ultra-minimal + dodatci samo ako kolone postoje)
  const payload: Record<string, any> = {};
  if (cols.has('tx_hash')) payload.tx_hash = tx;
  if (cols.has('amount'))  payload.amount  = amountEthStr;
  if (blockTimeISO && cols.has('block_time')) payload.block_time = blockTimeISO;

  // wallet mapiranje (ETH-aware scoring), samo ako kolona postoji
  if (toAddress && cols.has('wallet_id')) {
    const walletId = await resolveWalletIdByAddressETH(toAddress);
    if (walletId) payload.wallet_id = walletId;
  }

  // optional USD pricing (samo ako kolone postoje)
  const usdFlags = await tableHasColumns('contributions', ['amount_usd','priced_at']);
  if ((usdFlags.amount_usd || usdFlags.priced_at)) {
    const priced = await priceEthToUsdOrNull(amountEthStr);
    if (priced) {
      if (usdFlags.amount_usd) payload.amount_usd = priced.usd;
      if (usdFlags.priced_at)  payload.priced_at  = priced.pricedAt;
    }
  }

  if (!('tx_hash' in payload) || !('amount' in payload)) {
    return json(500, { ok: false, error: 'server_misconfigured_missing_columns(tx_hash/amount)' });
  }

  // 6) insert
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

