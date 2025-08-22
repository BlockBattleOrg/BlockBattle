// app/api/ingest/matic/route.ts
// Polygon (MATIC) native transfers ingestion with multi-RPC fallback.
// - Auth via x-cron-secret === process.env.CRON_SECRET
// - Cursor in settings: key 'matic_last_block' -> { n: <blockNumber> }
// - Tracks wallets where chain IN ('MATIC','polygon') AND is_active = true
// - Inserts into contributions (amount_usd = NULL), idempotent on (wallet_id, tx_hash)

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

const supabase = getSupabaseAdmin();

// CSV list first, then single URL, then safe public default
const MATIC_RPC_URLS: string[] = (
  process.env.MATIC_RPC_URLS ||
  process.env.MATIC_RPC_URL ||
  'https://polygon-rpc.com'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Tunables
const PER_ENDPOINT_TIMEOUT_MS = Number(process.env.MATIC_RPC_TIMEOUT_MS ?? 8000);
const START_LAG_BLOCKS = Number(process.env.MATIC_START_LAG ?? 500);
const MAX_BLOCKS_PER_RUN = Number(process.env.MATIC_MAX_BLOCKS ?? 250);
const CURSOR_KEY = 'matic_last_block';

type Hex = `0x${string}`;
type BlockTx = {
  hash: string;
  from: string | null;
  to: string | null;
  value: Hex; // wei (hex)
};
type Block = {
  number: Hex;
  timestamp: Hex; // seconds (hex)
  transactions: BlockTx[];
};

const hexToInt = (h: Hex | string) => parseInt(h, 16);
const toLower = (s?: string | null) => (s ? s.toLowerCase() : null);

// 18 decimals (MATIC native)
function weiToDecimal(weiHex: Hex): string {
  const wei = BigInt(weiHex);
  const base = 10n ** 18n;
  const whole = wei / base;
  const frac = wei % base;
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return fracStr ? `${whole}.${fracStr}` : whole.toString();
}

// --- RPC with fallback & timeout ---
async function rpcAttempt<T>(url: string, method: string, params: any[] = []): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PER_ENDPOINT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${body}`);
    }
    const json = await res.json();
    if (json?.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
    return json.result as T;
  } finally {
    clearTimeout(timer);
  }
}

async function rpc<T>(method: string, params: any[] = []): Promise<T> {
  let lastErr: any;
  for (const url of MATIC_RPC_URLS) {
    try {
      return await rpcAttempt<T>(url, method, params);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('All MATIC RPC endpoints failed');
}

// --- DB helpers ---
async function getActiveWallets(): Promise<Array<{ id: string; address: string }>> {
  const { data, error } = await supabase
    .from('wallets')
    .select('id, address')
    .in('chain', ['MATIC', 'polygon'])
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
    .upsert(
      { key: CURSOR_KEY, value: { n }, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  if (error) throw error;
}

async function insertContribution(wallet_id: string, tx_hash: string, amountStr: string, blockTimeIso: string) {
  try {
    const { error } = await supabase.from('contributions').insert({
      wallet_id,
      tx_hash,
      amount: amountStr,
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

// --- Handler ---
export async function POST(req: NextRequest) {
  const supplied = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const wallets = await getActiveWallets();
    if (!wallets.length) {
      return NextResponse.json({ ok: true, message: 'No active MATIC wallets.', inserted: 0 });
    }

    const addrMap = new Map<string, string>();
    for (const w of wallets) {
      const k = toLower(w.address || '');
      if (k) addrMap.set(k, w.id);
    }

    const latest = hexToInt(await rpc<Hex>('eth_blockNumber'));
    const cursor = await getCursor();

    const start = Math.max(0, (cursor ?? (latest - START_LAG_BLOCKS)) + 1);
    const end = Math.min(latest, start + MAX_BLOCKS_PER_RUN - 1);

    if (end < start) {
      return NextResponse.json({ ok: true, message: 'Up to date.', latest, processed: 0 });
    }

    let inserted = 0;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    for (let n = start; n <= end; n++) {
      const blockHex = `0x${n.toString(16)}` as Hex;
      const block = await rpc<Block>('eth_getBlockByNumber', [blockHex, true]);

      const tsIso = new Date(hexToInt(block.timestamp) * 1000).toISOString();
      if (!firstTs) firstTs = tsIso;
      lastTs = tsIso;

      if (block.transactions?.length) {
        for (const tx of block.transactions) {
          if (!tx.value || tx.value === '0x' || tx.value === '0x0') continue;

          const from = toLower(tx.from);
          const to = toLower(tx.to);

          const matched: string[] = [];
          if (from && addrMap.has(from)) matched.push(addrMap.get(from)!);
          if (to && addrMap.has(to)) matched.push(addrMap.get(to)!);
          if (!matched.length) continue;

          const amount = weiToDecimal(tx.value);
          for (const wallet_id of matched) {
            await insertContribution(wallet_id, tx.hash, amount, tsIso);
            inserted++;
          }
        }
      }

      if ((n - start) % 25 === 0) await setCursor(n);
    }

    await setCursor(end);

    return NextResponse.json({
      ok: true,
      chain: 'MATIC',
      range: { start, end },
      latest,
      blocks: end - start + 1,
      inserted,
      time_window: { firstTs, lastTs },
      rpc_endpoints_tried: MATIC_RPC_URLS.length,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('MATIC ingest error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';

