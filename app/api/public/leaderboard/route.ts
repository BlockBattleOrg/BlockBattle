// app/api/public/leaderboard/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Try to be resilient to slightly different column names.
// Expected columns (any of these shapes):
// - chain: string (preferred) OR currency/symbol
// - amount as smallest unit: sats/amount_sats/value_sats OR amount_native/amount
// - decimals: int (when amount is in smallest unit but not sats)
// - txid/hash (optional), timestamp/created_at (optional)
type Row = Record<string, any>;

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) {
    throw new Error('Missing Supabase env: need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function pickChain(r: Row): string | null {
  const c =
    r.chain ?? r.symbol ?? r.currency ?? r.chain_symbol ?? r.chain_id ?? null;
  return typeof c === 'string' && c.trim() ? c.trim().toUpperCase() : null;
}

function toNumber(x: any): number | null {
  if (x == null) return null;
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() && Number.isFinite(Number(x))) return Number(x);
  return null;
}

// Convert any known contribution shape to a float in native units (e.g., BTC, ETH).
function pickAmountNative(r: Row): number {
  // UTXO-style sats fields
  const sats =
    toNumber(r.sats) ??
    toNumber(r.value_sats) ??
    toNumber(r.valueSats) ??
    null;
  if (sats != null) return sats / 1e8; // BTC-like chains

  // Generic "amount" in smallest units + decimals
  const smallest =
    toNumber(r.amount_native) ??
    toNumber(r.amount) ??
    toNumber(r.value) ??
    null;
  if (smallest != null) {
    const decimals =
      toNumber(r.decimals) ??
      // common defaults per chain (fallback if decimals missing)
      (pickChain(r) === 'ETH' || pickChain(r) === 'OP' || pickChain(r) === 'ARB' || pickChain(r) === 'POL' || pickChain(r) === 'AVAX'
        ? 18
        : 8);
    return smallest / Math.pow(10, decimals ?? 8);
  }

  // Already a float?
  const f =
    toNumber(r.amount_native_float) ??
    toNumber(r.amount_float) ??
    null;
  return f ?? 0;
}

function pickTimestampISO(r: Row): string | null {
  const t =
    r.timestamp ??
    r.block_time ??
    r.block_timestamp ??
    r.created_at ??
    null;
  if (typeof t === 'string') return t;
  if (typeof t === 'number' && Number.isFinite(t)) {
    // assume unix seconds
    return new Date((t > 1e12 ? t : t * 1000)).toISOString();
  }
  return null;
}

export async function GET() {
  try {
    const supabase = getSupabase();

    // Pull recent contributions (cap at 10k to stay lean)
    const { data, error } = await supabase
      .from('contributions')
      .select('*')
      .limit(10000);

    if (error) throw error;

    const rows: Row[] = Array.isArray(data) ? data : [];

    // Aggregate totals by chain
    const totalsMap = new Map<string, { total: number; count: number }>();
    const recent: Array<{ chain: string; amount: number; txid?: string; timestamp?: string | null }> = [];

    for (const r of rows) {
      const chain = pickChain(r);
      if (!chain) continue;

      const amount = pickAmountNative(r);
      const txid = (r.txid ?? r.hash ?? r.tx_hash ?? r.transaction_hash) as string | undefined;
      const ts = pickTimestampISO(r);

      // Build recent list (take first N after loop)
      recent.push({ chain, amount, txid, timestamp: ts });

      const entry = totalsMap.get(chain) ?? { total: 0, count: 0 };
      entry.total += amount;
      entry.count += 1;
      totalsMap.set(chain, entry);
    }

    const totals = Array.from(totalsMap.entries())
      .map(([chain, v]) => ({ chain, total: v.total, contribution_count: v.count }))
      .sort((a, b) => b.total - a.total);

    // Keep last 20 recent (by timestamp if present)
    recent.sort((a, b) => {
      const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
      const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
      return tb - ta;
    });
    const recentTop = recent.slice(0, 20);

    return NextResponse.json(
      { ok: true, totals, recent: recentTop },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

