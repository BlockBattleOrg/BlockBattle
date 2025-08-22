// app/api/ingest/arb/route.ts
// Arbitrum One (ARB) native transfers ingestion — ETH-pattern with multi-RPC fallback.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';
const supabase = getSupabaseAdmin();

const ARB_RPC_URLS: string[] = (
  process.env.ARB_RPC_URLS ||
  process.env.ARB_RPC_URL ||
  'https://arbitrum-one.publicnode.com,https://arbitrum.llamarpc.com,https://arb1.arbitrum.io/rpc'
).split(',').map(s => s.trim()).filter(Boolean);

const PER_ENDPOINT_TIMEOUT_MS = Number(process.env.ARB_RPC_TIMEOUT_MS ?? 8000);
const START_LAG_BLOCKS = Number(process.env.ARB_START_LAG ?? 500);
const MAX_BLOCKS_PER_RUN = Number(process.env.ARB_MAX_BLOCKS ?? 250);
const CURSOR_KEY = 'arb_last_block';

type Hex = `0x${string}`;
type BlockTx = { hash: string; from: string|null; to: string|null; value: Hex; };
type Block = { number: Hex; timestamp: Hex; transactions: BlockTx[]; };

const hexToInt = (h: Hex | string) => parseInt(h, 16);
const toLower = (s?: string | null) => (s ? s.toLowerCase() : null);
function weiToDecimal(weiHex: Hex): string {
  const wei = BigInt(weiHex), base = 10n**18n;
  const whole = wei / base, frac = wei % base;
  const fs = frac.toString().padStart(18,'0').replace(/0+$/,'');
  return fs ? `${whole}.${fs}` : whole.toString();
}

async function rpcAttempt<T>(url: string, method: string, params: any[]=[]): Promise<T> {
  const ctl = new AbortController(); const timer = setTimeout(()=>ctl.abort(), PER_ENDPOINT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }), signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const j = await res.json(); if (j?.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
    return j.result as T;
  } finally { clearTimeout(timer); }
}
async function rpc<T>(method: string, params: any[]=[]): Promise<T> {
  let last:any; for (const url of ARB_RPC_URLS) { try { return await rpcAttempt<T>(url,method,params); } catch(e){ last=e; } }
  throw last ?? new Error('All ARB RPC endpoints failed');
}

async function getActiveWallets() {
  const { data, error } = await supabase.from('wallets').select('id,address')
    .in('chain', ['ARB','arb','arbitrum']).eq('is_active', true);
  if (error) throw error; return data ?? [];
}
async function getCursor(): Promise<number|null> {
  const { data, error } = await supabase.from('settings').select('value').eq('key', CURSOR_KEY).maybeSingle();
  if (error) throw error; const n = Number(data?.value?.n); return Number.isFinite(n) ? n : null;
}
async function setCursor(n:number) {
  const { error } = await supabase.from('settings').upsert({ key: CURSOR_KEY, value:{ n }, updated_at:new Date().toISOString() }, { onConflict:'key' });
  if (error) throw error;
}
async function insertContribution(wallet_id:string, tx_hash:string, amountStr:string, ts:string) {
  try {
    const { error } = await supabase.from('contributions').insert({ wallet_id, tx_hash, amount: amountStr, amount_usd: null, block_time: ts });
    if (error) throw error;
  } catch (e:any) { if (/duplicate key value violates unique constraint/i.test(String(e?.message||e))) return; throw e; }
}

export async function POST(req: NextRequest) {
  const supplied = req.headers.get('x-cron-secret'); const expected = process.env.CRON_SECRET;
  if (!expected || supplied !== expected) return NextResponse.json({ ok:false, error:'unauthorized' }, { status: 401 });
  try {
    const wallets = await getActiveWallets();
    if (!wallets.length) return NextResponse.json({ ok:true, message:'No active ARB wallets.', inserted:0 });

    const addrMap = new Map<string,string>(); for (const w of wallets) { const k = toLower(w.address||''); if (k) addrMap.set(k, w.id); }
    const latest = hexToInt(await rpc<Hex>('eth_blockNumber'));
    const cursor = await getCursor();
    const start = Math.max(0, (cursor ?? (latest - START_LAG_BLOCKS)) + 1);
    const end = Math.min(latest, start + MAX_BLOCKS_PER_RUN - 1);
    if (end < start) return NextResponse.json({ ok:true, message:'Up to date.', latest, processed:0 });

    let inserted = 0, firstTs: string|null = null, lastTs: string|null = null;
    for (let n = start; n <= end; n++) {
      const block = await rpc<Block>('eth_getBlockByNumber', [`0x${n.toString(16)}`, true]);
      const ts = new Date(hexToInt(block.timestamp)*1000).toISOString(); if (!firstTs) firstTs = ts; lastTs = ts;
      for (const tx of (block.transactions||[])) {
        if (!tx.value || tx.value === '0x' || tx.value === '0x0') continue;
        const from = toLower(tx.from), to = toLower(tx.to);
        const matched:string[] = []; if (from && addrMap.has(from)) matched.push(addrMap.get(from)!); if (to && addrMap.has(to)) matched.push(addrMap.get(to)!);
        if (!matched.length) continue;
        const amount = weiToDecimal(tx.value); for (const wallet_id of matched) { await insertContribution(wallet_id, tx.hash, amount, ts); inserted++; }
      }
      if ((n - start) % 25 === 0) await setCursor(n);
    }
    await setCursor(end);
    return NextResponse.json({ ok:true, chain:'ARB', range:{ start, end }, latest, blocks:end-start+1, inserted, time_window:{ firstTs, lastTs }, rpc_endpoints_tried: ARB_RPC_URLS.length });
  } catch (err:any) {
    const msg = err?.message || String(err); console.error('ARB ingest error:', msg);
    return NextResponse.json({ ok:false, error: msg }, { status: 500 });
  }
}
export const dynamic = 'force-dynamic';

