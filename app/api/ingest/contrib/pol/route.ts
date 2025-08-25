import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BATCH_BLOCKS = 250;
const MAX_LOOKBACK = 5_000;

type Hex = `0x${string}`;
const toBig = (x: Hex | string | null | undefined) => BigInt(x ?? '0x0');
const hexToInt = (x: Hex | string) => Number(BigInt(x));

function weiToDecimal(wei: Hex | string, decimals = 18): string {
  const v = toBig(wei);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return whole.toString();
  let f = frac.toString().padStart(decimals, '0');
  f = f.replace(/0+$/, '');
  return `${whole.toString()}.${f}`;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env.');
  return createClient(url, key, { auth: { persistSession: false } });
}

async function rpc<T=any>(url: string, key: string, method: string, params: any[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'api-key': key },
    body: JSON.stringify({ jsonrpc:'2.0', id:1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(json.error?.message || 'RPC error');
  return json.result as T;
}
const tag = (n: number) => ('0x' + n.toString(16)) as Hex;

export async function POST(req: Request) {
  try {
    const sec = process.env.CRON_SECRET;
    if (sec && req.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const RPC = (process.env.POL_RPC_URL || '').trim();
    const KEY = (process.env.NOWNODES_API_KEY || '').trim();
    if (!RPC) return NextResponse.json({ ok: false, error: 'Missing POL_RPC_URL' }, { status: 500 });
    if (!KEY) return NextResponse.json({ ok: false, error: 'Missing NOWNODES_API_KEY' }, { status: 500 });

    const sb = getSupabase();

    // Find active POL wallet (by currencies.symbol='POL' or chain synonyms)
    const { data: wallets, error: werr } = await sb
      .from('wallets')
      .select('id, address, chain, is_active, currencies:currency_id(symbol, name, decimals)')
      .eq('is_active', true);
    if (werr) throw werr;

    const isPol = (sym?: string|null, name?: string|null, chain?: string|null) => {
      const s = (sym||'').toUpperCase();
      const n = (name||'').toUpperCase();
      const c = (chain||'').toUpperCase();
      return s === 'POL' || n.includes('POLYGON') || c === 'POL' || c === 'POLYGON' || c === 'MATIC';
    };

    const w = (wallets || []).find((r: any) => isPol(r?.currencies?.symbol, r?.currencies?.name, r?.chain));
    if (!w) return NextResponse.json({ ok: false, error: 'No active POL wallet found' }, { status: 200 });

    const walletId: string = w.id;
    const toAddr = String(w.address).toLowerCase();
    const decimals: number = Number(w?.currencies?.decimals ?? 18) || 18;

    // Determine range
    const latestHex = await rpc<Hex>(RPC, KEY, 'eth_blockNumber', []);
    const latest = hexToInt(latestHex);

    const { data: srow, error: serr } = await sb
      .from('settings')
      .select('value')
      .eq('key', 'pol_contrib_last_scanned')
      .maybeSingle();
    if (serr) throw serr;

    let last = 0;
    if (srow?.value) {
      const v = srow.value;
      last = typeof v === 'number' ? v : (typeof v?.n !== 'undefined' ? Number(v.n) : 0);
    }

    const start = Math.max(last + 1, latest - MAX_LOOKBACK);
    const end = Math.min(start + BATCH_BLOCKS - 1, latest);
    if (end < start) {
      return NextResponse.json({ ok: true, scanned: 0, latest, from: null, to: null, inserted: 0 });
    }

    // Scan blocks
    let inserted = 0;
    const upserts: any[] = [];

    for (let b = start; b <= end; b++) {
      const block = await rpc<any>(RPC, KEY, 'eth_getBlockByNumber', [tag(b), true]);
      const ts = new Date(hexToInt(block.timestamp as Hex) * 1000).toISOString();
      for (const tx of block.transactions || []) {
        const to = String(tx.to || '').toLowerCase();
        if (!to || to !== toAddr) continue;
        const value = toBig(tx.value || '0x0');
        if (value <= 0n) continue;
        upserts.push({
          wallet_id: walletId,
          tx_hash: String(tx.hash),
          amount: weiToDecimal(tx.value, decimals),  // stored as numeric (native units)
          amount_usd: null,
          block_time: ts,
        });
      }
    }

    if (upserts.length) {
      const { error: uerr } = await sb.from('contributions').upsert(upserts, {
        onConflict: 'wallet_id,tx_hash',
      });
      if (uerr) throw uerr;
      inserted = upserts.length;
    }

    const { error: setErr } = await sb
      .from('settings')
      .upsert({ key: 'pol_contrib_last_scanned', value: { n: end } }, { onConflict: 'key' });
    if (setErr) throw setErr;

    return NextResponse.json({ ok: true, latest, from: start, to: end, scanned: end - start + 1, inserted });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

