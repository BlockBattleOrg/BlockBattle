// app/api/ingest/eth/route.ts
// ETH native transfers ingestion — aligned with BTC route style:
// - Auth via x-cron-secret compared strictly to process.env.CRON_SECRET (no defaults)
// - Cursor stored in settings under key 'eth_last_block' as { n: <blockNumber> }
// - Matches active ETH wallets (chain IN ['ETH','ethereum'])
// - Inserts rows into contributions with amount_usd = NULL

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

const supabase = getSupabaseAdmin();
const ETH_RPC_URL = process.env.ETH_RPC_URL || 'https://cloudflare-eth.com';

type Hex = `0x${string}`;
type BlockTx = {
  hash: string;
  from: string | null;
  to: string | null;
  value: Hex;
};
type Block = {
  number: Hex;
  timestamp: Hex;
  transactions: BlockTx[];
};

async function rpc<T>(method: string, params: any[] = []): Promise<T> {
  const res = await fetch(ETH_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} ${res.status}: ${await res.text()}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

const hexToInt = (h: Hex | string) => parseInt(h, 16);
const toLower = (s?: string | null) => (s ? s.toLowerCase() : s);

function weiToEthDecimal(weiHex: Hex): string {
  const wei = BigInt(weiHex);
  const base = 10n ** 18n;
  const whole = wei / base;
  const frac = wei % base;
  let fs = frac.toString().padStart(18, '0').replace(/0+$/, '');
  return fs ? `${whole}.${fs}` : whole.toString();
}

async function getActiveEthWallets() {
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
    .eq('key', 'eth_last_block')
    .maybeSingle();
  if (error) throw error;
  const n = Number(data?.value?.n);
  return Number.isFinite(n) ? n : null;
}

async function setCursor(n: number) {
  const { error } = await supabase
    .from('settings')
    .upsert(
      { key: 'eth_last_block', value: { n }, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );
  if (error) throw error;
}

async function insertContribution(wallet_id: string, tx_hash: string, amount: string, block_time_iso: string) {
  try {
    const { error } = await supabase.from('contributions').insert({
      wallet_id,
      tx_hash,
      amount,           // numeric
      amount_usd: null, // MVP
      block_time: block_time_iso,
    });
    if (error) throw error;
  } catch (e: any) {
    const msg = String(e?.message || e);
    // If DB has unique constraint on (wallet_id, tx_hash), ignore duplicates
    if (/duplicate key value violates unique constraint/i.test(msg)) return;
    throw e;
  }
}

export async function POST(req: NextRequest) {
  // Auth — identical contract as BTC: require exact match with env
  const supplied = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  try {
    const wallets = await getActiveEthWallets();
    if (!wallets.length) {
      return NextResponse.json({ ok: true, message: 'No active ETH wallets.', inserted: 0 });
    }

    const addrMap = new Map<string, string>();
    for (const w of wallets) {
      const k = toLower(w.address || '');
      if (k) addrMap.set(k, w.id);
    }

    const latest = hexToInt(await rpc<Hex>('eth_blockNumber'));
    const cursor = await getCursor();

    const START_LAG = 500;   // safety near tip (similar to BTC style)
    const MAX_BLOCKS = 250;  // small batch to be rate-friendly

    const start = Math.max(0, (cursor ?? (latest - START_LAG)) + 1);
    const end = Math.min(latest, start + MAX_BLOCKS - 1);

    if (end < start) {
      return NextResponse.json({ ok: true, message: 'Up to date.', latest, processed: 0 });
    }

    let inserted = 0;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    for (let n = start; n <= end; n++) {
      const block = await rpc<Block>('eth_getBlockByNumber', [`0x${n.toString(16)}`, true]);
      const ts = new Date(hexToInt(block.timestamp) * 1000).toISOString();
      if (!firstTs) firstTs = ts;
      lastTs = ts;

      if (block.transactions?.length) {
        for (const tx of block.transactions) {
          if (!tx.value || tx.value === '0x' || tx.value === '0x0') continue;

          const from = toLower(tx.from);
          const to = toLower(tx.to);

          const matched: string[] = [];
          if (from && addrMap.has(from)) matched.push(addrMap.get(from)!);
          if (to && addrMap.has(to)) matched.push(addrMap.get(to)!);
          if (!matched.length) continue;

          const amount = weiToEthDecimal(tx.value);
          for (const wallet_id of matched) {
            await insertContribution(wallet_id, tx.hash, amount, ts);
            inserted++;
          }
        }
      }

      // periodic cursor bump to avoid reprocessing if run is interrupted
      if ((n - start) % 25 === 0) await setCursor(n);
    }

    await setCursor(end);

    return NextResponse.json({
      ok: true,
      chain: 'ETH',
      range: { start, end },
      latest,
      blocks: end - start + 1,
      inserted,
      time_window: { firstTs, lastTs },
    });
  } catch (err: any) {
    console.error('ETH ingest error:', err?.message || err);
    return NextResponse.json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}

// keep server runtime behavior consistent with BTC (dynamic route)
export const dynamic = 'force-dynamic';

