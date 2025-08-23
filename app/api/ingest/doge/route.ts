// app/api/ingest/doge/route.ts
// Dogecoin (UTXO) ingestion via public explorer APIs with multi-endpoint fallback & per-request retries.
// - Auth: x-cron-secret === process.env.CRON_SECRET
// - Cursor: settings.key='doge_last_height' -> { n: <blockHeight> }
// - Tracks: wallets.chain IN ('DOGE','doge','dogecoin') AND is_active = true
// - Inserts: one row per matched output (and prevout spent) with amount in DOGE (8 decimals)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

const supabase = getSupabaseAdmin();

// Prefer SoChain first; dogechain as fallback (može throttle-at)
const DOGE_API_URLS: string[] = (
  process.env.DOGE_API_URLS ||
  process.env.DOGE_API_URL ||
  'https://sochain.com/api/v2,https://dogechain.info/api/v1'
).split(',').map(s => s.trim()).filter(Boolean);

const PER_ENDPOINT_TIMEOUT_MS = Number(process.env.DOGE_API_TIMEOUT_MS ?? 15000); // 15s
const START_LAG_HEIGHTS = Number(process.env.DOGE_START_LAG ?? 3);
const MAX_HEIGHTS_PER_RUN = Number(process.env.DOGE_MAX_HEIGHTS ?? 10);         // manji batch
const CURSOR_KEY = 'doge_last_height';

// ---------- utils ----------
const toLower = (s?: string | null) => (s ? s.toLowerCase() : null);
function satsToDecimalString(sats: number | undefined | null): string {
  const v = BigInt(Math.max(0, Number(sats || 0)));
  const base = 10n ** 8n;
  const whole = v / base;
  const frac = v % base;
  const fs = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return fs ? `${whole}.${fs}` : whole.toString();
}

async function fetchWithTimeout(url: string) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PER_ENDPOINT_TIMEOUT_MS);
  try { return await fetch(url, { signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

async function getJson(url: string, attempts = 2): Promise<any> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      return await res.json();
    } catch (e) { last = e; }
  }
  throw last ?? new Error(`Failed JSON fetch ${url}`);
}

async function getText(url: string, attempts = 2): Promise<string> {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      return (await res.text()).trim();
    } catch (e) { last = e; }
  }
  throw last ?? new Error(`Failed TEXT fetch ${url}`);
}

// ---------- API adapters ----------
// Tip height: probaj SoChain pa DogeChain.
async function getTipHeight(): Promise<number> {
  let last: any;
  for (const base of DOGE_API_URLS) {
    try {
      if (base.includes('sochain.com')) {
        const j = await getJson(`${base.replace(/\/+$/,'')}/get_info/DOGE`);
        const n = Number(j?.data?.blocks);
        if (Number.isFinite(n)) return n;
      } else if (base.includes('dogechain.info')) {
        // 1) latest block endpoint
        try {
          const j = await getJson(`${base.replace(/\/+$/,'')}/block/latest`);
          const n = Number(j?.data?.block?.height);
          if (Number.isFinite(n)) return n;
        } catch {}
        // 2) blockchain info
        const info = await getJson(`${base.replace(/\/+$/,'')}/blockchain/info`);
        const n2 = Number(info?.data?.blocks);
        if (Number.isFinite(n2)) return n2;
      }
    } catch (e) { last = e; }
  }
  throw last ?? new Error('Cannot determine DOGE tip height');
}

// Block by height — pokušaj SoChain “get_block/DOGE/{height}” (vrati sve), fallback dogechain (hash→txids)
type SoBlock = { blockhash: string; time: number; txs: Array<{ txid: string }> };
async function getBlockViaSoChain(base: string, height: number): Promise<SoBlock> {
  const j = await getJson(`${base.replace(/\/+$/,'')}/get_block/DOGE/${height}`);
  return {
    blockhash: String(j?.data?.blockhash || ''),
    time: Number(j?.data?.time || Math.floor(Date.now()/1000)),
    txs: Array.isArray(j?.data?.txs) ? j.data.txs.map((tx: any) => ({ txid: String(tx?.txid || '') })) : []
  };
}

async function getBlockHashByHeight_DogeChain(base: string, h: number): Promise<string> {
  const hash = await getText(`${base.replace(/\/+$/,'')}/block/height/${h}`);
  if (!hash || hash.length < 32) throw new Error(`Unexpected dogechain block hash: ${hash}`);
  return hash;
}
async function getBlockTxids_DogeChain(base: string, hash: string): Promise<string[]> {
  const j = await getJson(`${base.replace(/\/+$/,'')}/block/${hash}`);
  if (j?.success && Array.isArray(j?.data?.tx)) return j.data.tx.map((t: any) => String(t.hash || '')).filter(Boolean);
  throw new Error('dogechain block payload unexpected');
}

// Tx detail — podrži oba formata
type TxDetail = { tsIso: string; vouts: Array<{ address: string, valueSats: number }>, vins: Array<{ address: string, valueSats: number }> };
async function getTxDetail(base: string, txid: string): Promise<TxDetail> {
  if (base.includes('sochain.com')) {
    const j = await getJson(`${base.replace(/\/+$/,'')}/get_tx/DOGE/${txid}`);
    // sochain: { status:"success", data:{ txid, time, inputs[], outputs[] } }
    const t = j?.data;
    const tsIso = new Date(Number(t?.time || Math.floor(Date.now()/1000)) * 1000).toISOString();
    const vouts = (t?.outputs ?? []).map((o: any) => ({
      address: String(o?.address || ''),
      valueSats: Math.round(parseFloat(o?.value || '0') * 1e8),
    }));
    const vins = (t?.inputs ?? []).map((i: any) => ({
      address: String(i?.from_output?.address || ''),
      valueSats: Math.round(parseFloat(i?.from_output?.value || '0') * 1e8),
    }));
    return { tsIso, vouts, vins };
  } else {
    // dogechain: /api/v1/transaction/{txid}
    const j = await getJson(`${base.replace(/\/+$/,'')}/transaction/${txid}`);
    const t = j?.data?.transaction;
    const tsIso = new Date(Number(t?.time || Math.floor(Date.now()/1000)) * 1000).toISOString();
    const vouts = (t?.outputs ?? []).map((o: any) => ({
      address: String(o?.address || ''),
      valueSats: Number(o?.value_satoshi || 0),
    }));
    const vins = (t?.inputs ?? []).map((i: any) => ({
      address: String(i?.address || ''),
      valueSats: Number(i?.value_satoshi || 0),
    }));
    return { tsIso, vouts, vins };
  }
}

// High-level: fetch block (prefer SoChain single call), else fall back to dogechain combo
async function getBlockEnvelope(height: number): Promise<{ tsIso: string, txids: string[] }> {
  let last: any;

  for (const base of DOGE_API_URLS) {
    try {
      if (base.includes('sochain.com')) {
        const b = await getBlockViaSoChain(base, height);
        const tsIso = new Date(b.time * 1000).toISOString();
        const txids = (b.txs || []).map(t => t.txid).filter(Boolean);
        return { tsIso, txids };
      } else if (base.includes('dogechain.info')) {
        const hash = await getBlockHashByHeight_DogeChain(base, height);
        const txids = await getBlockTxids_DogeChain(base, hash);
        // nemamo block_time iz block call-a, ali uzet ćemo vrijeme iz tx-a (prvi koji stigne)
        return { tsIso: new Date().toISOString(), txids };
      }
    } catch (e) { last = e; }
  }
  throw last ?? new Error(`All DOGE endpoints failed for height ${height}`);
}

// ---------- DB helpers ----------
async function getActiveWallets(): Promise<Array<{ id: string; address: string }>> {
  const { data, error } = await supabase
    .from('wallets')
    .select('id,address')
    .in('chain', ['DOGE','doge','dogecoin'])
    .eq('is_active', true);
  if (error) throw error;
  return (data ?? []);
}
async function getCursor(): Promise<number | null> {
  const { data, error } = await supabase.from('settings').select('value').eq('key', CURSOR_KEY).maybeSingle();
  if (error) throw error;
  const n = Number(data?.value?.n);
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
      wallet_id, tx_hash, amount: amountStr, amount_usd: null, block_time: ts
    });
    if (error) throw error;
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/duplicate key value violates unique constraint/i.test(msg)) return;
    throw e;
  }
}

// ---------- handler ----------
export async function POST(req: NextRequest) {
  const supplied = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok:false, error:'unauthorized' }, { status: 401 });
  }

  try {
    const wallets = await getActiveWallets();
    if (!wallets.length) return NextResponse.json({ ok:true, message:'No active DOGE wallets.', inserted: 0 });

    const addrMap = new Map<string,string>();
    for (const w of wallets) { const k = toLower(w.address || ''); if (k) addrMap.set(k, w.id); }

    const tip = await getTipHeight();
    const cursor = await getCursor();
    const start = Math.max(0, (cursor ?? (tip - START_LAG_HEIGHTS)) + 1);
    const end = Math.min(tip, start + MAX_HEIGHTS_PER_RUN - 1);
    if (end < start) return NextResponse.json({ ok:true, message:'Up to date.', tip, processed: 0 });

    let inserted = 0;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    for (let h = start; h <= end; h++) {
      const { tsIso: blockTsIso, txids } = await getBlockEnvelope(h);
      for (const txid of txids) {
        // pokušaj SoChain pa dogechain (kroz DOGE_API_URLS)
        let detail: TxDetail | null = null;
        let last: any;
        for (const base of DOGE_API_URLS) {
          try { detail = await getTxDetail(base, txid); break; } catch (e) { last = e; }
        }
        if (!detail) throw last ?? new Error(`Cannot fetch DOGE tx ${txid}`);

        const ts = detail.tsIso || blockTsIso;
        if (!firstTs) firstTs = ts; lastTs = ts;

        for (const o of detail.vouts) {
          const a = toLower(o.address || ''); if (!a || !addrMap.has(a)) continue;
          const amt = satsToDecimalString(o.valueSats);
          await insertContribution(addrMap.get(a)!, txid, amt, ts);
          inserted++;
        }
        for (const i of detail.vins) {
          const a = toLower(i.address || ''); if (!a || !addrMap.has(a)) continue;
          const amt = satsToDecimalString(i.valueSats);
          await insertContribution(addrMap.get(a)!, txid, amt, ts);
          inserted++;
        }
      }

      if ((h - start) % 3 === 0) await setCursor(h); // češći cursor bump za siguran napredak
    }

    await setCursor(end);

    return NextResponse.json({
      ok: true,
      chain: 'DOGE',
      range: { start, end },
      tip,
      heights: end - start + 1,
      inserted,
      time_window: { firstTs, lastTs },
      api_endpoints_tried: DOGE_API_URLS.length,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('DOGE ingest error:', msg);
    return NextResponse.json({ ok:false, error: msg }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';

