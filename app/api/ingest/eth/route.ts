// app/api/ingest/eth/route.ts
// ETH native transfers ingestion (mirror of BTC flow).
// - Secured via x-cron-secret
// - Cursor saved in settings.key='eth_last_block' as { n: <number> }
// - Scans blocks in small batches with full txs = true
// - Matches against active ETH wallets
// - Inserts into contributions (amount_usd stays NULL)
// Notes:
// * wallets.chain can be 'ETH' or 'ethereum' — we accept both.

import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const CRON_SECRET = process.env.CRON_SECRET || 'OvoJeVrloJakaFora1972';
const ETH_RPC_URL = process.env.ETH_RPC_URL || 'https://cloudflare-eth.com';

type Hex = `0x${string}`;
type BlockTx = {
  hash: string;
  from: string | null;
  to: string | null;
  value: Hex; // hex-wei
};
type Block = {
  number: Hex;
  timestamp: Hex; // hex-seconds
  transactions: BlockTx[];
};

async function rpc<T>(method: string, params: any[] = []): Promise<T> {
  const res = await fetch(ETH_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

const hexToInt = (h: Hex | string) => parseInt(h, 16);

const weiToEthDecimal = (weiHex: Hex) => {
  const wei = BigInt(weiHex);
  const ETH_DECIMALS = 18n;
  const base = 10n ** ETH_DECIMALS;
  const whole = wei / base;
  const frac = wei % base;
  let fracStr = frac.toString().padStart(Number(ETH_DECIMALS), '0').replace(/0+$/, '');
  return fracStr.length ? `${whole}.${fracStr}` : whole.toString();
};

const toLower = (s?: string | null) => (s ? s.toLowerCase() : s);

async function getActiveEthWallets() {
  const { data, error } = await supabaseAdmin
    .from('wallets')
    .select('id, address')
    .in('chain', ['ETH', 'ethereum'])
    .eq('is_active', true);
  if (error) throw error;
  return data ?? [];
}

async function getCursor(): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from('settings')
    .select('value')
    .eq('key', 'eth_last_block')
    .maybeSingle();
  if (error) throw error;
  const n = Number(data?.value?.n);
  return Number.isFinite(n) ? n : null;
}

async function setCursor(n: number) {
  const { error } = await supabaseAdmin
    .from('settings')
    .upsert({ key: 'eth_last_block', value: { n }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

async function insertContribution(wallet_id: string, tx_hash: string, amountEthStr: string, blockTimeIso: string) {
  try {
    const { error } = await supabaseAdmin.from('contributions').insert({
      wallet_id,
      tx_hash,
      amount: amountEthStr,    // numeric
      amount_usd: null,        // MVP: left NULL
      block_time: blockTimeIso // timestamptz
    });
    if (error) throw error;
  } catch (e: any) {
    const msg = String(e?.message || e);
    // Swallow duplicates if a unique constraint exists on (wallet_id, tx_hash)
    if (/duplicate key value violates unique constraint/i.test(msg)) return;
    throw e;
  }
}

export async function POST(req: NextRequest) {
  try {
    // Auth: same as BTC
    const hdr = req.headers.get('x-cron-secret');
    if (!hdr || hdr !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    // Prepare tracked addresses
    const wallets = await getActiveEthWallets();
    if (!wallets.length) {
      return NextResponse.json({ ok: true, message: 'No active ETH wallets.', inserted: 0 });
    }
    const addrToWallet = new Map<string, string>();
    for (const w of wallets) {
      const key = toLower(w.address || '');
      if (key) addrToWallet.set(key, w.id);
    }

    // Determine block window
    const latestHex = await rpc<Hex>('eth_blockNumber');
    const latest = hexToInt(latestHex);
    const cursor = await getCursor();

    const START_LAG = 500;          // safety window behind tip
    const MAX_BLOCKS = 250;         // rate-friendly
    const start = Math.max(0, (cursor ?? (latest - START_LAG)) + 1);
    const end = Math.min(latest, start + MAX_BLOCKS - 1);

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

      if (!block.transactions?.length) {
        if ((n - start) % 25 === 0) await setCursor(n);
        continue;
      }

      for (const tx of block.transactions) {
        const from = toLower(tx.from);
        const to = toLower(tx.to);
        const hasValue = tx.value && tx.value !== '0x0' && tx.value !== '0x';
        if (!hasValue) continue;

        const matched: string[] = [];
        if (from && addrToWallet.has(from)) matched.push(addrToWallet.get(from)!);
        if (to && addrToWallet.has(to)) matched.push(addrToWallet.get(to)!);
        if (!matched.length) continue;

        const amountStr = weiToEthDecimal(tx.value);
        for (const wallet_id of matched) {
          await insertContribution(wallet_id, tx.hash, amountStr, tsIso);
          inserted++;
        }
      }

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

export const dynamic = 'force-dynamic';

