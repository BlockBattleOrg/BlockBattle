// app/api/ingest/ltc/route.ts
// Litecoin (UTXO) ingestion via litecoinspace (mempool-style) API with multi-endpoint fallback.
// - Auth: x-cron-secret === process.env.CRON_SECRET
// - Cursor: settings.key='ltc_last_height' -> { n: <blockHeight> }
// - Tracks: wallets.chain IN ('LTC','ltc','litecoin') AND is_active = true
// - Inserts: one row per matched output (and prevout spent) with amount in LTC (8 decimals)
// - Idempotent by (wallet_id, tx_hash) unique (app-level guard keeps it safe too)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

const supabase = getSupabaseAdmin();

// CSV first, then single, then safe defaults (two mirrors)
const LTC_API_URLS: string[] = (
  process.env.LTC_API_URLS ||
  process.env.LTC_API_URL ||
  'https://litecoinspace.org/api,https://litecoinspace.com/api'
).split(',').map(s => s.trim()).filter(Boolean);

const PER_ENDPOINT_TIMEOUT_MS = Number(process.env.LTC_API_TIMEOUT_MS ?? 8000);
const START_LAG_HEIGHTS = Number(process.env.LTC_START_LAG ?? 3);       // stay a few blocks behind tip
const MAX_HEIGHTS_PER_RUN = Number(process.env.LTC_MAX_HEIGHTS ?? 50);  // process up to 50 heights per run
const CURSOR_KEY = 'ltc_last_height';

// ---- helpers ----
type TxVin = {
  txid?: string;
  vout?: number;
  prevout?: { value?: number; scriptpubkey_address?: string | null } | null;
};
type TxVout = {
  value?: number; // in litoshis (sats)
  scriptpubkey_address?: string | null;
};
type Tx = {
  txid: string;
  vin: TxVin[];
  vout: TxVout[];
  status?: { block_time?: number };
};

function toLower(s?: string | null): string | null { return s ? s.toLowerCase() : null; }
function satsToDecimalString(sats: number | undefined | null): string {
  const v = BigInt(Math.max(0, Number(sats || 0)));
  const base = 10n ** 8n;
  const whole = v / base;
  const frac = v % base;
  const fs = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return fs ? `${whole}.${fs}` : whole.toString();
}

async function httpAttempt<T>(base: string, path: string): Promise<T> {
  const url = `${base.replace(/\/+$/,'')}/${path.replace(/^\/+/,'')}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), PER_ENDPOINT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  } finally { clearTimeout(t); }
}
async function http<T>(path: string): Promise<T> {
  let last: any;
  for (const base of LTC_API_URLS) {
    try { return await httpAttempt<T>(base, path); } catch (e) { last = e; }
  }
  throw last ?? new Error('All LTC API endpoints failed');
}

// ---- DB ----
async function getActiveWallets(): Promise<Array<{ id: string; address: string }>> {
  const { data, error } = await supabase
    .from('wallets')
    .select('id,address')
    .in('chain', ['LTC','ltc','litecoin'])
    .eq('is_active', true);
  if (error) throw error;
  return data ?? [];
}
async function getCursor(): Promise<number | null> {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', CURSOR_KEY)
    .maybeSingle();
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
async function insertContribution(wallet_id: string, tx_hash: string, amountStr: string, blockTimeIso: string) {
  try {
    const { error } = await supabase.from('contributions').insert({
      wallet_id,
      tx_hash,
      amount: amountStr,     // numeric in LTC
      amount_usd: null,
      block_time: blockTimeIso,
    });
    if (error) throw error;
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/duplicate key value violates unique constraint/i.test(msg)) return; // idempotent
    throw e;
  }
}

// ---- Ingest ----
export async function POST(req: NextRequest) {
  const supplied = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok:false, error:'unauthorized' }, { status: 401 });
  }
  try {
    // wallets
    const wallets = await getActiveWallets();
    if (!wallets.length) {
      return NextResponse.json({ ok:true, message:'No active LTC wallets.', inserted:0 });
    }
    const addrMap = new Map<string, string>();
    for (const w of wallets) { const k = toLower(w.address||''); if (k) addrMap.set(k, w.id); }

    // tip height
    const tip: number = await http<number>('blocks/tip/height');
    const cursor = await getCursor();
    const start = Math.max(0, (cursor ?? (tip - START_LAG_HEIGHTS)) + 1);
    const end = Math.min(tip, start + MAX_HEIGHTS_PER_RUN - 1);
    if (end < start) {
      return NextResponse.json({ ok:true, message:'Up to date.', tip, processed:0 });
    }

    let inserted = 0;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    for (let h = start; h <= end; h++) {
      // height -> block hash -> txids
      const blockHash: string = await http<string>(`block-height/${h}`);
      const txids: string[] = await http<string[]>(`block/${blockHash}/txids`);

      for (const txid of txids) {
        const tx: Tx = await http<Tx>(`tx/${txid}`);

        const ts = tx?.status?.block_time ? new Date(tx.status.block_time * 1000).toISOString() : new Date().toISOString();
        if (!firstTs) firstTs = ts; lastTs = ts;

        // match outputs to our addresses
        for (const vout of tx.vout || []) {
          const addr = toLower(vout.scriptpubkey_address || '');
          if (!addr || !addrMap.has(addr)) continue;
          const amount = satsToDecimalString(vout.value ?? 0);
          await insertContribution(addrMap.get(addr)!, tx.txid, amount, ts);
          inserted++;
        }

        // optionally also record spends (prevout owners) as positive "activity" entries
        for (const vin of tx.vin || []) {
          const pa = toLower(vin.prevout?.scriptpubkey_address || '');
          if (!pa || !addrMap.has(pa)) continue;
          const amount = satsToDecimalString(vin.prevout?.value ?? 0);
          await insertContribution(addrMap.get(pa)!, tx.txid, amount, ts);
          inserted++;
        }
      }

      if ((h - start) % 5 === 0) { await setCursor(h); }
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
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('LTC ingest error:', msg);
    return NextResponse.json({ ok:false, error: msg }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';

