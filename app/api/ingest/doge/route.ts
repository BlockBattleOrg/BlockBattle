// app/api/ingest/doge/route.ts
// Dogecoin (UTXO) ingestion via public explorer APIs with multi-endpoint fallback.
// - Auth: x-cron-secret === process.env.CRON_SECRET
// - Cursor: settings.key='doge_last_height' -> { n: <blockHeight> }
// - Tracks: wallets.chain IN ('DOGE','doge','dogecoin') AND is_active = true
// - Inserts: one row per matched output (and prevout spent) with amount in DOGE (8 decimals)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

const supabase = getSupabaseAdmin();

// Two explorers (try in order). First is dogechain.info v1 JSON, second is sochain (simple JSON).
const DOGE_API_URLS: string[] = (
  process.env.DOGE_API_URLS ||
  process.env.DOGE_API_URL ||
  'https://dogechain.info/api/v1,https://sochain.com/api/v2'
).split(',').map(s => s.trim()).filter(Boolean);

const PER_ENDPOINT_TIMEOUT_MS = Number(process.env.DOGE_API_TIMEOUT_MS ?? 8000);
const START_LAG_HEIGHTS = Number(process.env.DOGE_START_LAG ?? 3);
const MAX_HEIGHTS_PER_RUN = Number(process.env.DOGE_MAX_HEIGHTS ?? 50);
const CURSOR_KEY = 'doge_last_height';

// normalize API paths per base (we handle two flavors)
async function httpAttempt(base: string, path: string): Promise<any> {
  const url = `${base.replace(/\/+$/,'')}/${path.replace(/^\/+/,'')}`;
  const ctl = new AbortController();
  const t = setTimeout(()=>ctl.abort(), PER_ENDPOINT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    return await res.json();
  } finally { clearTimeout(t); }
}
async function http(base: string, path: string): Promise<any> {
  return httpAttempt(base, path);
}
async function httpAny(paths: string[]): Promise<any> {
  let last: any;
  for (const base of DOGE_API_URLS) {
    for (const p of paths) {
      try { return await http(base, p); } catch (e) { last = e; }
    }
  }
  throw last ?? new Error('All DOGE API endpoints failed');
}

function toLower(s?: string | null) { return s ? s.toLowerCase() : null; }
function satsToDecimalString(sats: number | undefined | null): string {
  const v = BigInt(Math.max(0, Number(sats || 0)));
  const base = 10n ** 8n;
  const whole = v / base;
  const frac = v % base;
  const fs = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return fs ? `${whole}.${fs}` : whole.toString();
}

type SochainTxOutput = { value: string; address: string }; // value is decimal DOGE as string
type SochainTxInput  = { from_output: { value: string; address: string } | null };

async function getTipHeight(): Promise<number> {
  // Try dogechain first
  try {
    const j = await httpAny(['api/v1/block/latest', 'get_info/DOGE']); // dogechain then sochain
    // dogechain: { success:1, data:{ block:{ height: N, ... } } }
    if (j?.success && j?.data?.block?.height) return Number(j.data.block.height);
    // sochain: { status:"success", data:{ blocks: N, ... } } (fallback endpoint name varies)
    if (j?.status === 'success' && j?.data?.blocks) return Number(j.data.blocks);
  } catch (_) {}
  // another dogechain endpoint:
  const info = await httpAny(['api/v1/blockchain/info', 'get_info/DOGE']);
  if (info?.success && info?.data?.blocks) return Number(info.data.blocks);
  if (info?.status === 'success' && info?.data?.blocks) return Number(info.data.blocks);
  throw new Error('Cannot determine DOGE tip height');
}

async function getBlockHashByHeight(h: number): Promise<string> {
  // dogechain: /api/v1/block/height/{h}
  const j = await httpAny([`api/v1/block/height/${h}`]);
  if (j?.success && j?.data?.block?.hash) return j.data.block.hash;
  // sochain route for hash-by-height may not exist; we rely on dogechain for this step
  throw new Error(`Cannot get Doge block hash at height ${h}`);
}

async function getBlockTxids(hash: string): Promise<string[]> {
  // dogechain: /api/v1/block/{hash}
  const j = await httpAny([`api/v1/block/${hash}`]);
  if (j?.success && Array.isArray(j?.data?.tx)) {
    return j.data.tx.map((t: any) => t.hash).filter(Boolean);
  }
  throw new Error('Cannot get txids for doge block');
}

async function getTx(txid: string): Promise<{ ts: string, vouts: Array<{address: string, valueSats: number}>, vins: Array<{address: string, valueSats: number}> }> {
  // First try dogechain tx
  try {
    const j = await httpAny([`api/v1/transaction/${txid}`, `get_tx/DOGE/${txid}`]); // dogechain, then sochain
    // dogechain format:
    if (j?.success && j?.data?.transaction) {
      const t = j.data.transaction;
      const ts = new Date((t.time ?? Math.floor(Date.now()/1000)) * 1000).toISOString();
      const vouts = (t.outputs ?? []).map((o: any) => ({ address: String(o.address || ''), valueSats: Number(o.value_satoshi || 0) }));
      const vins  = (t.inputs  ?? []).map((i: any) => ({ address: String(i.address || ''), valueSats: Number(i.value_satoshi || 0) }));
      return { ts, vouts, vins };
    }
    // sochain format:
    if (j?.status === 'success' && j?.data?.txid) {
      const t = j.data;
      const ts = new Date((t.time ?? Math.floor(Date.now()/1000)) * 1000).toISOString();
      const vouts: Array<{address:string,valueSats:number}> = (t.outputs ?? []).map((o: SochainTxOutput) => ({
        address: o.address, valueSats: Math.round(parseFloat(o.value || '0') * 1e8)
      }));
      const vins: Array<{address:string,valueSats:number}> = (t.inputs ?? []).map((i: SochainTxInput) => ({
        address: i?.from_output?.address || '', valueSats: Math.round(parseFloat(i?.from_output?.value || '0') * 1e8)
      }));
      return { ts, vouts, vins };
    }
  } catch (_) {}
  throw new Error(`Cannot fetch DOGE tx ${txid}`);
}

// ---- DB helpers (shared with LTC style) ----
async function getActiveWallets(): Promise<Array<{ id: string; address: string }>> {
  const { data, error } = await supabase
    .from('wallets')
    .select('id,address')
    .in('chain', ['DOGE','doge','dogecoin'])
    .eq('is_active', true);
  if (error) throw error;
  return data ?? [];
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
async function insertContribution(wallet_id: string, tx_hash: string, amountStr: string, blockTimeIso: string) {
  try {
    const { error } = await supabase.from('contributions').insert({
      wallet_id, tx_hash, amount: amountStr, amount_usd: null, block_time: blockTimeIso
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
    if (!wallets.length) return NextResponse.json({ ok:true, message:'No active DOGE wallets.', inserted:0 });
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
        const ts = tx.ts;
        if (!firstTs) firstTs = ts; lastTs = ts;

        for (const o of tx.vouts) {
          const a = toLower(o.address||''); if (!a || !addrMap.has(a)) continue;
          const amt = satsToDecimalString(o.valueSats);
          await insertContribution(addrMap.get(a)!, txid, amt, ts);
          inserted++;
        }
        for (const i of tx.vins) {
          const a = toLower(i.address||''); if (!a || !addrMap.has(a)) continue;
          const amt = satsToDecimalString(i.valueSats);
          await insertContribution(addrMap.get(a)!, txid, amt, ts);
          inserted++;
        }
      }

      if ((h - start) % 5 === 0) await setCursor(h);
    }

    await setCursor(end);

    return NextResponse.json({
      ok:true,
      chain:'DOGE',
      range:{ start, end },
      tip,
      heights: end - start + 1,
      inserted,
      time_window:{ firstTs, lastTs },
      api_endpoints_tried: DOGE_API_URLS.length,
    });
  } catch (err:any) {
    const msg = err?.message || String(err);
    console.error('DOGE ingest error:', msg);
    return NextResponse.json({ ok:false, error: msg }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';

