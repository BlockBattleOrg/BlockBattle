// app/api/ingest/doge/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

const supabase = getSupabaseAdmin();

const SOCHAIN_BASE = (process.env.DOGE_API_URLS || 'https://sochain.com/api/v2')
  .split(',').map(s => s.trim()).find(u => u.includes('sochain.com')) || 'https://sochain.com/api/v2';

const TIMEOUT_MS = Number(process.env.DOGE_API_TIMEOUT_MS ?? 15000);
const START_LAG = Number(process.env.DOGE_START_LAG ?? 3);
const MAX_HEIGHTS = Number(process.env.DOGE_MAX_HEIGHTS ?? 10);
const CURSOR_KEY = 'doge_last_height';

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
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
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

// --- SoChain adapters ---
async function getTipHeight(): Promise<number> {
  const j = await getJson(`${SOCHAIN_BASE.replace(/\/+$/,'')}/get_info/DOGE`);
  const n = Number(j?.data?.blocks);
  if (!Number.isFinite(n)) throw new Error('Unexpected tip height payload');
  return n;
}

type SoBlock = { blockhash: string; time: number; txs: Array<{ txid: string }> };
async function getBlock(height: number): Promise<SoBlock> {
  const j = await getJson(`${SOCHAIN_BASE.replace(/\/+$/,'')}/get_block/DOGE/${height}`);
  return {
    blockhash: String(j?.data?.blockhash || ''),
    time: Number(j?.data?.time || Math.floor(Date.now()/1000)),
    txs: Array.isArray(j?.data?.txs) ? j.data.txs.map((tx: any) => ({ txid: String(tx?.txid || '') })) : []
  };
}

type TxDetail = { tsIso: string; vouts: Array<{ address: string, valueSats: number }>, vins: Array<{ address: string, valueSats: number }> };
async function getTxDetail(txid: string): Promise<TxDetail> {
  const j = await getJson(`${SOCHAIN_BASE.replace(/\/+$/,'')}/get_tx/DOGE/${txid}`);
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
}

// --- DB helpers ---
async function getActiveWallets(): Promise<Array<{ id: string; address: string }>> {
  const { data, error } = await supabase
    .from('wallets').select('id,address')
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

// --- handler ---
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
    const start = Math.max(0, (cursor ?? (tip - START_LAG)) + 1);
    const end = Math.min(tip, start + MAX_HEIGHTS - 1);
    if (end < start) return NextResponse.json({ ok:true, message:'Up to date.', tip, processed: 0 });

    let inserted = 0;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    for (let h = start; h <= end; h++) {
      const b = await getBlock(h);
      const blockTs = new Date(b.time * 1000).toISOString();
      for (const { txid } of b.txs) {
        const detail = await getTxDetail(txid);
        const ts = detail.tsIso || blockTs;
        if (!firstTs) firstTs = ts; lastTs = ts;

        for (const o of detail.vouts) {
          const a = toLower(o.address || ''); if (!a || !addrMap.has(a)) continue;
          await insertContribution(addrMap.get(a)!, txid, satsToDecimalString(o.valueSats), ts);
          inserted++;
        }
        for (const i of detail.vins) {
          const a = toLower(i.address || ''); if (!a || !addrMap.has(a)) continue;
          await insertContribution(addrMap.get(a)!, txid, satsToDecimalString(i.valueSats), ts);
          inserted++;
        }
      }
      if ((h - start) % 3 === 0) await setCursor(h);
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
      provider: 'sochain',
    });
  } catch (err:any) {
    const msg = err?.message || String(err);
    console.error('DOGE ingest error:', msg);
    return NextResponse.json({ ok:false, error: msg }, { status: 500 });
  }
}

