// app/api/ingest/ltc/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// ---------- ENV / constants ----------
const supabase = getSupabaseAdmin();

const LTC_RPC_URL = (process.env.LTC_RPC_URL || '').trim();                  // npr. https://go.getblock.io/<token>/
const RPC_TIMEOUT_MS = Number(process.env.LTC_RPC_TIMEOUT_MS ?? 8000);

const LTC_API_URLS: string[] = (
  process.env.LTC_API_URLS ||
  process.env.LTC_API_URL ||
  'https://litecoinspace.org/api,https://litecoinspace.com/api'
).split(',').map(s => s.trim()).filter(Boolean);
const REST_TIMEOUT_MS = Number(process.env.LTC_API_TIMEOUT_MS ?? 8000);

const START_LAG = Number(process.env.LTC_START_LAG ?? 3);
const MAX_HEIGHTS = Number(process.env.LTC_MAX_HEIGHTS ?? 25);

// koliko dugo dopuštamo radu handlera prije urednog prekida (ispod vercel hard‑limita)
const BUDGET_MS = Number(process.env.LTC_BUDGET_MS ?? 45_000);

const CURSOR_KEY = 'ltc_last_height';

// ---------- small utils ----------
const toLower = (s?: string | null) => (s ? s.toLowerCase() : null);

function satsToDecimalString(sats: number | undefined | null): string {
  const v = BigInt(Math.max(0, Number(sats || 0)));
  const base = 10n ** 8n;
  const whole = v / base;
  const frac = v % base;
  const fs = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return fs ? `${whole}.${fs}` : whole.toString();
}

async function fetchWithTimeout(url: string, ms: number) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------- DB helpers ----------
async function getActiveWallets(): Promise<Array<{ id: string; address: string }>> {
  const { data, error } = await supabase
    .from('wallets').select('id,address')
    .in('chain', ['LTC', 'ltc', 'litecoin'])
    .eq('is_active', true);
  if (error) throw error;
  return data ?? [];
}

async function getCursor(): Promise<number | null> {
  const { data, error } = await supabase
    .from('settings').select('value').eq('key', CURSOR_KEY).maybeSingle();
  if (error) throw error;
  const n = Number((data as any)?.value?.n);
  return Number.isFinite(n) ? n : null;
}

async function setCursor(n: number): Promise<void> {
  const { error } = await supabase
    .from('settings')
    .upsert({ key: CURSOR_KEY, value: { n }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

async function insertContribution(wallet_id: string, tx_hash: string, amountStr: string, ts: string) {
  try {
    const { error } = await supabase.from('contributions').insert({
      wallet_id, tx_hash, amount: amountStr, amount_usd: null, block_time: ts,
    });
    if (error) throw error;
  } catch (e: any) {
    const msg = String(e?.message || e);
    // idempotency: ignore unique constraint on (wallet_id, tx_hash, amount, block_time) if postoji
    if (/duplicate key value violates unique constraint/i.test(msg)) return;
    throw e;
  }
}

// ---------- RPC (GetBlock JSON‑RPC) ----------
type RpcResp<T> = { jsonrpc: '2.0'; id: number; result?: T; error?: { code: number; message: string } };
type RpcTxVin = { prevout?: { value?: number; scriptPubKey?: { address?: string | null } } | null } | any;
type RpcTxVout = { value?: number; scriptPubKey?: { address?: string | null } } | any;
type RpcVerboseTx = { txid: string; vin?: RpcTxVin[]; vout?: RpcTxVout[]; time?: number; blocktime?: number };
type RpcBlock = { time?: number; tx?: (string | RpcVerboseTx)[] };

async function rpcCall<T = any>(method: string, params: any[] = []): Promise<T> {
  if (!LTC_RPC_URL) throw new Error('LTC_RPC_URL not set');
  const ctl = new AbortController();
  const tid = setTimeout(() => ctl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(LTC_RPC_URL, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status} ${await res.text()}`);
    const j = await res.json() as RpcResp<T>;
    if ((j as any)?.error) throw new Error(`RPC ${method} error: ${JSON.stringify((j as any).error)}`);
    return (j as any).result as T;
  } finally {
    clearTimeout(tid);
  }
}

async function rpcGetTipHeight(): Promise<number> {
  return await rpcCall<number>('getblockcount');
}
async function rpcGetBlockHashByHeight(h: number): Promise<string> {
  return await rpcCall<string>('getblockhash', [h]);
}
async function rpcGetBlockVerbose(hash: string): Promise<RpcBlock> {
  // verbosity=2 -> kompletni tx-evi
  return await rpcCall<RpcBlock>('getblock', [hash, 2]);
}
async function rpcGetRawTxVerbose(txid: string): Promise<RpcVerboseTx> {
  return await rpcCall<RpcVerboseTx>('getrawtransaction', [txid, true]);
}

// ---------- REST (litecoinspace) ----------
async function restGetTipHeight(): Promise<number> {
  let lastErr: any;
  for (const base of LTC_API_URLS) {
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/+$/, '')}/blocks/tip/height`, REST_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const txt = (await res.text()).trim();
      const n = Number(txt);
      if (!Number.isFinite(n)) throw new Error(`Unexpected tip height: ${txt}`);
      return n;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('All REST endpoints failed (tip height)');
}

async function restGetBlockHashByHeight(h: number): Promise<string> {
  let lastErr: any;
  for (const base of LTC_API_URLS) {
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/+$/, '')}/block-height/${h}`, REST_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const hash = (await res.text()).trim();
      if (!hash || hash.length < 32) throw new Error(`Unexpected block hash: ${hash}`);
      return hash;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error(`All REST endpoints failed (block hash @ ${h})`);
}

async function restGetBlockTxids(hash: string): Promise<string[]> {
  let lastErr: any;
  for (const base of LTC_API_URLS) {
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/+$/, '')}/block/${hash}/txids`, REST_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error('Unexpected txids payload');
      return arr as string[];
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error(`All REST endpoints failed (txids for ${hash})`);
}

type RestTx = {
  status?: { block_time?: number };
  vin?: Array<{ prevout?: { value?: number; scriptpubkey_address?: string | null } | null }>;
  vout?: Array<{ value?: number; scriptpubkey_address?: string | null }>;
};

async function restGetTx(txid: string): Promise<{ tsIso: string; vins: Array<{ address: string|null, valueSats: number }>; vouts: Array<{ address: string|null, valueSats: number }>; }> {
  let lastErr: any;
  for (const base of LTC_API_URLS) {
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/+$/, '')}/tx/${txid}`, REST_TIMEOUT_MS);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const json = await res.json() as RestTx;
      const ts = json?.status?.block_time ? new Date(json.status.block_time * 1000).toISOString() : new Date().toISOString();
      const vins = (json.vin || []).map(i => ({
        address: i?.prevout?.scriptpubkey_address ?? null,
        valueSats: Math.round((i?.prevout?.value ?? 0) * 1e8),
      }));
      const vouts = (json.vout || []).map(o => ({
        address: o?.scriptpubkey_address ?? null,
        valueSats: Math.round((o?.value ?? 0) * 1e8),
      }));
      return { tsIso: ts, vins, vouts };
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error(`All REST endpoints failed (tx ${txid})`);
}

// ---------- Unified adapters (RPC first, fallback to REST) ----------
async function getTipHeight(): Promise<number> {
  try { return await rpcGetTipHeight(); } catch { /* fallback */ }
  return await restGetTipHeight();
}
async function getBlockHashByHeight(h: number): Promise<string> {
  try { return await rpcGetBlockHashByHeight(h); } catch { /* fallback */ }
  return await restGetBlockHashByHeight(h);
}
async function getBlockTxidsAndMaybeVerbose(hash: string): Promise<{ txids: string[]; verbose?: RpcVerboseTx[] }> {
  try {
    const b = await rpcGetBlockVerbose(hash);
    const verbose: RpcVerboseTx[] = [];
    const txids: string[] = [];
    for (const t of (b.tx || [])) {
      if (typeof t === 'string') txids.push(t);
      else { verbose.push(t); txids.push(t.txid); }
    }
    return { txids, verbose };
  } catch {
    const txids = await restGetBlockTxids(hash);
    return { txids };
  }
}

async function getTxUnified(txid: string): Promise<{
  txid: string;
  ts: string;
  vins: Array<{ address: string | null; valueSats: number }>;
  vouts: Array<{ address: string | null; valueSats: number }>;
}> {
  try {
    const v = await rpcGetRawTxVerbose(txid);
    const tsSec = v.blocktime || v.time || Math.floor(Date.now() / 1000);
    return {
      txid,
      ts: new Date(tsSec * 1000).toISOString(),
      vins: (v.vin || []).map((i: any) => ({
        address: i?.prevout?.scriptPubKey?.address ?? null,
        valueSats: Math.round(((i?.prevout?.value ?? 0) as number) * 1e8),
      })),
      vouts: (v.vout || []).map((o: any) => ({
        address: o?.scriptPubKey?.address ?? null,
        valueSats: Math.round(((o?.value ?? 0) as number) * 1e8),
      })),
    };
  } catch {
    const r = await restGetTx(txid);
    return {
      txid,
      ts: r.tsIso,
      vins: r.vins,
      vouts: r.vouts,
    };
  }
}

// ---------- Handler ----------
export async function POST(req: NextRequest) {
  const supplied = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();

  try {
    const wallets = await getActiveWallets();
    if (!wallets.length) {
      return NextResponse.json({ ok: true, message: 'No active LTC wallets.', inserted: 0 });
    }

    const addrMap = new Map<string, string>();
    for (const w of wallets) {
      const k = toLower(w.address || '');
      if (k) addrMap.set(k, w.id);
    }

    const tip = await getTipHeight();
    const cursor = await getCursor();
    const start = Math.max(0, (cursor ?? (tip - START_LAG)) + 1);
    const end = Math.min(tip, start + MAX_HEIGHTS - 1);
    if (end < start) return NextResponse.json({ ok: true, message: 'Up to date.', tip, processed: 0 });

    let inserted = 0;
    let processedHeights = 0;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    for (let h = start; h <= end; h++) {
      // soft deadline
      if (Date.now() - t0 > BUDGET_MS) {
        await setCursor(h - 1 >= start ? h - 1 : start - 1);
        return NextResponse.json({
          ok: true,
          chain: 'LTC',
          partial: true,
          reason: 'deadline',
          processed_heights: processedHeights,
          tip,
          inserted,
          time_window: { firstTs, lastTs },
        });
      }

      const hash = await getBlockHashByHeight(h);
      const { txids, verbose } = await getBlockTxidsAndMaybeVerbose(hash);

      // ako već imamo verbose tx iz RPC bloka, iskoristi ih; inače pojedinačno dovuci
      const verboseMap = new Map<string, RpcVerboseTx>();
      if (verbose?.length) {
        for (const v of verbose) verboseMap.set(v.txid, v);
      }

      for (const txid of txids) {
        let ts: string;
        let vins: Array<{ address: string | null; valueSats: number }>;
        let vouts: Array<{ address: string | null; valueSats: number }>;

        if (verboseMap.has(txid)) {
          const v = verboseMap.get(txid)!;
          const tsSec = v.blocktime || v.time || Math.floor(Date.now() / 1000);
          ts = new Date(tsSec * 1000).toISOString();
          vins = (v.vin || []).map((i: any) => ({
            address: i?.prevout?.scriptPubKey?.address ?? null,
            valueSats: Math.round(((i?.prevout?.value ?? 0) as number) * 1e8),
          }));
          vouts = (v.vout || []).map((o: any) => ({
            address: o?.scriptPubKey?.address ?? null,
            valueSats: Math.round(((o?.value ?? 0) as number) * 1e8),
          }));
        } else {
          const t = await getTxUnified(txid);
          ts = t.ts; vins = t.vins; vouts = t.vouts;
        }

        if (!firstTs) firstTs = ts;
        lastTs = ts;

        for (const o of vouts) {
          const a = toLower(o.address || '');
          if (!a || !addrMap.has(a)) continue;
          await insertContribution(addrMap.get(a)!, txid, satsToDecimalString(o.valueSats), ts);
          inserted++;
        }
        for (const i of vins) {
          const a = toLower(i.address || '');
          if (!a || !addrMap.has(a)) continue;
          await insertContribution(addrMap.get(a)!, txid, satsToDecimalString(i.valueSats), ts);
          inserted++;
        }
      }

      processedHeights++;
      if ((h - start) % 5 === 0) await setCursor(h); // incremental checkpoint
    }

    await setCursor(end);

    return NextResponse.json({
      ok: true,
      chain: 'LTC',
      range: { start, end },
      tip,
      heights: end - start + 1,
      inserted,
      time_window: { firstTs, lastTs },
      api_endpoints_tried: LTC_API_URLS.length,
      provider: LTC_RPC_URL ? 'rpc+rest' : 'rest',
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('LTC ingest error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

