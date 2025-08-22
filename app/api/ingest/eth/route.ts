// app/api/ingest/eth/route.ts
// ETH native transfers ingestion with multi-RPC fallback.
// - Auth via x-cron-secret === process.env.CRON_SECRET (no defaults).
// - Cursor in settings: key 'eth_last_block' -> { n: <blockNumber> }.
// - Tracks wallets where chain IN ('ETH','ethereum') AND is_active = true.
// - Inserts into contributions (amount_usd = NULL), idempotent on (wallet_id, tx_hash).
// - Tries multiple RPC endpoints from ETH_RPC_URLS (CSV) or ETH_RPC_URL, with per-endpoint timeout.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

const supabase = getSupabaseAdmin();

// Allow comma-separated list in ETH_RPC_URLS; fallback to single ETH_RPC_URL; final fallback to Cloudflare.
const ETH_RPC_URLS: string[] = (
  process.env.ETH_RPC_URLS ||
  process.env.ETH_RPC_URL ||
  'https://cloudflare-eth.com'
)
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Tunables
const PER_ENDPOINT_TIMEOUT_MS = Number(process.env.ETH_RPC_TIMEOUT_MS ?? 8000); // 8s per attempt
const START_LAG_BLOCKS = Number(process.env.ETH_START_LAG ?? 500);             // safety window behind tip
const MAX_BLOCKS_PER_RUN = Number(process.env.ETH_MAX_BLOCKS ?? 250);          // friendly batch size
const CURSOR_KEY = 'eth_last_block';

type Hex = `0x${string}`;
type BlockTx = {
  hash: string;
  from: string | null;
  to: string | null;
  value: Hex; // hex-encoded wei
};
type Block = {
  number: Hex;
  timestamp: Hex; // hex-encoded seconds
  transactions: BlockTx[];
};

function hexToInt(h: Hex | string): number {
  return parseInt(h, 16);
}

function toLower(s?: string | null): string | null {
  return s ? s.toLowerCase() : null;
}

function weiToEthDecimal(weiHex: Hex): string {
  const wei = BigInt(weiHex);
  const base = 10n ** 18n;
  const whole = wei / base;
  const frac = wei % base;
  const fracStr = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
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
  for (const url of ETH_RPC_URLS) {
    try {
      return await rpcAttempt<T>(url, method, params);
    } catch (e) {
      lastErr = e;
      // try next endpoint
    }
  }
  throw lastErr ?? new Error('All ETH RPC endpoints failed');
}

// --- DB helpers ---
async function getActiveEthWallets(): Promise<Array<{ id: string; address: string }>> {
  const { data, error } = await supabase
    .from('wallets')
    .select('id, address')
    .in('chain', ['ETH', 'ethereum'])
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

async function insertContribution(wallet_id: string, tx_hash: string, amountEthStr: string, blockTimeIso: string) {
  try {
    const { error } = await supabase.from('contributions').insert({
      wallet_id,
      tx_hash,
      amount: amountEthStr,    // numeric
      amount_usd: null,        // MVP
      block_time: blockTimeIso // timestamptz
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
  // Auth like BTC: require exact match with env secret; do NOT default
  const supplied = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    // Load tracked wallets
    const wallets = await getActiveEthWallets();
    if (!wallets.length) {
      return NextResponse.json({ ok: true, message: 'No active ETH wallets.', inserted: 0 });
    }

    // Address -> wallet_id map (lowercased)
    const addrMap = new Map<string, string>();
    for (const w of wallets) {
      const k = toLower(w.address || '');
      if (k) addrMap.set(k, w.id);
    }

    // Determine block range
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
          // Only native ETH value transfers (> 0)
          if (!tx.value || tx.value === '0x' || tx.value === '0x0') continue;

          const from = toLower(tx.from);
          const to = toLower(tx.to);

          const matched: string[] = [];
          if (from && addrMap.has(from)) matched.push(addrMap.get(from)!);
          if (to && addrMap.has(to)) matched.push(addrMap.get(to)!);
          if (!matched.length) continue;

          const amount = weiToEthDecimal(tx.value);
          for (const wallet_id of matched) {
            await insertContribution(wallet_id, tx.hash, amount, tsIso);
            inserted++;
          }
        }
      }

      // Periodic cursor bump (in case of mid-run interruption)
      if ((n - start) % 25 === 0) await setCursor(n);
    }

    // Finalize cursor
    await setCursor(end);

    return NextResponse.json({
      ok: true,
      chain: 'ETH',
      range: { start, end },
      latest,
      blocks: end - start + 1,
      inserted,
      time_window: { firstTs, lastTs },
      rpc_endpoints_tried: ETH_RPC_URLS.length,
    });
  } catch (err: any) {
    // Surface last RPC or DB error
    const msg = err?.message || String(err);
    console.error('ETH ingest error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

export const dynamic = 'force-dynamic';

