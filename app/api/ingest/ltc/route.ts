// app/api/ingest/ltc/route.ts
// Litecoin (UTXO) ingestion via litecoinspace (mempool-style) API with multi-endpoint fallback.
// - Auth: x-cron-secret === process.env.CRON_SECRET
// - Cursor: settings.key='ltc_last_height' -> { n: <blockHeight> }
// - Tracks: wallets.chain IN ('LTC','ltc','litecoin') AND is_active = true
// - Inserts: one row per matched output (and prevout spent) with amount in LTC (8 decimals)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
const supabase = getSupabaseAdmin();

const LTC_API_URLS: string[] = (
  process.env.LTC_API_URLS ||
  process.env.LTC_API_URL ||
  'https://litecoinspace.org/api,https://litecoinspace.com/api'
).split(',').map(s => s.trim()).filter(Boolean);

const PER_ENDPOINT_TIMEOUT_MS = Number(process.env.LTC_API_TIMEOUT_MS ?? 8000);
const START_LAG_HEIGHTS = Number(process.env.LTC_START_LAG ?? 3);
const MAX_HEIGHTS_PER_RUN = Number(process.env.LTC_MAX_HEIGHTS ?? 50);
const CURSOR_KEY = 'ltc_last_height';

type TxVin = {
  prevout?: { value?: number; scriptpubkey_address?: string | null } | null;
};
type TxVout = { value?: number; scriptpubkey_address?: string | null };
type Tx = {
  txid: string;
  vin: TxVin[];
  vout: TxVout[];
  status?: { block_time?: number };
};

const toLower = (s?: string | null) => (s ? s.toLowerCase() : null);
function satsToDecimalString(sats: number | undefined | null): string {
  const v = BigInt(Math.max(0, Number(sats || 0)));
  const base = 10n ** 8n;
  const whole = v / base;
  const frac = v % base;
  const fs = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return fs ? `${whole}.${fs}` : whole.toString();
}

// ---- low-level HTTP helpers (handle text vs json by endpoint) ----
async function fetchWithTimeout(url: string) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PER_ENDPOINT_TIMEOUT_MS);
  try { return await fetch(url, { signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// mempool-style: returns TEXT number
async function getTipHeight(): Promise<number> {
  let lastErr: any;
  for (const base of LTC_API_URLS) {
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/+$/,'')}/blocks/tip/height`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const txt = (await res.text()).trim();
      const n = Number(txt);
      if (!Number.isFinite(n)) throw new Error(`Unexpected tip height: ${txt}`);
      return n;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('All LTC API endpoints failed (tip height)');
}

// mempool-style: returns TEXT hash
async function getBlockHashByHeight(h: number): Promise<string> {
  let lastErr: any;
  for (const base of LTC_API_URLS) {
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/+$/,'')}/block-height/${h}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const hash = (await res.text()).trim();
      if (!hash || hash.length < 32) throw new Error(`Unexpected block hash: ${hash}`);
      return hash;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error(`All LTC API endpoints failed (block hash @ ${h})`);
}

// JSON array of txids
async function getBlockTxids(hash: string): Promise<string[]> {
  let lastErr: any;
  for (const base of LTC_API_URLS) {
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/+$/,'')}/block/${hash}/txids`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const arr = await res.json();
      if (!Array.isArray(arr)) throw new Error('Unexpected txids payload');
      return arr as string[];
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error(`All LTC API endpoints failed (txids for ${hash})`);
}

// JSON tx detail
async function getTx(txid: string): Promise<Tx> {
  let lastErr: any;
  for (const base of LTC_API_URLS) {
    try {
      const res = await fetchWithTimeout(`${base.replace(/\/+$/,'')}/tx/${txid}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
      const json = await res.json();
      if (!json?.txid) throw new Error('Unexpected tx payload');
      return json as Tx;
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error(`All LTC API endpoints failed (tx ${txid})`);
}

// ---- DB helpers ----
async function getActiveWallets() {
  const { data, error } = await supabase
    .from('wallets').select('id,address')
    .in('chain', ['LTC','ltc','litecoin'])
    .eq('is_active', true);
  if (error) throw error;
  return data ?? [];
}
async function getCursor(): Promise<number | null> {
  const { data, error } = await supabase
    .from('settings').select('value').eq('key', CURSOR_KEY).maybeSingle();
  if (error) throw error;
  const n = Number(data?.value?.n);
  return Number.isFinite(n) ? n : null;
}
async function setCursor(n: number) {
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
  } catch (e:any) {
    const msg = String(e?.message || e);
    if (/duplicate key value violates unique constraint/i.test(msg)) return;
    throw e;
  }
}

// ---- handler ----
export async function POST(req: NextRequest) {
  const supplied = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok:false, error:'unauthorized' }, { status: 401 });
  }
  try {
    const wallets = await getActiveWallets();
    if (!wallets.length) return NextResponse.json({ ok:true, message:'No active LTC wallets.', inserted:0 });

    const addrMap = new Map<string,string>();
    for (const w of wallets) { const k = toLower(w.address||''); if (k) addrMap.set(k, w.id); }

    const tip = await getTipHeight();
    const cursor = await getCursor();
    const start = Math.max(0, (cursor ?? (tip - START_LAG_HEIGHTS)) + 1);
    const end = Math.min(tip, start + MAX_HEIGHTS_PER_RUN - 1);
    if (end < start) return NextResponse.json({ ok:true, message:'Up to date.', tip, processed:0 });

    let inserted = 0;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    for (let h = start; h <= end; h++) {
      const hash = await getBlockHashByHeight(h);
      const txids = await getBlockTxids(hash);

      for (const txid of txids) {
        const tx = await getTx(txid);
        const ts = tx?.status?.block_time ? new Date(tx.status.block_time * 1000).toISOString() : new Date().toISOString();
        if (!firstTs) firstTs = ts; lastTs = ts;

        for (const vout of tx.vout || []) {
          const a = toLower(vout.scriptpubkey_address || ''); if (!a || !addrMap.has(a)) continue;
          const amt = satsToDecimalString(vout.value ?? 0);
          await insertContribution(addrMap.get(a)!, txid, amt, ts); inserted++;
        }
        for (const vin of tx.vin || []) {
          const a = toLower(vin.prevout?.scriptpubkey_address || ''); if (!a || !addrMap.has(a)) continue;
          const amt = satsToDecimalString(vin.prevout?.value ?? 0);
          await insertContribution(addrMap.get(a)!, txid, amt, ts); inserted++;
        }
      }
      if ((h - start) % 5 === 0) await setCursor(h);
    }

    await setCursor(end);

    return NextResponse.json({
      ok:true, chain:'LTC',
      range:{ start, end }, tip, heights:end-start+1, inserted,
      time_window:{ firstTs, lastTs },
      api_endpoints_tried: LTC_API_URLS.length,
    });
  } catch (err:any) {
    const msg = err?.message || String(err);
    console.error('LTC ingest error:', msg);
    return NextResponse.json({ ok:false, error: msg }, { status: 500 });
  }
}
export const dynamic = 'force-dynamic';

