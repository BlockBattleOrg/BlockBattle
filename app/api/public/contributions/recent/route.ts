import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sbClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env.');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET() {
  try {
    const sb = sbClient();
    const { data, error } = await sb
      .from('contributions')
      .select('tx_hash, amount, block_time, wallet:wallet_id(is_active, currencies:currency_id(symbol))')
      .order('block_time', { ascending: false })
      .limit(20);
    if (error) throw error;

    const rows = (data ?? [])
      .filter((r) => r.wallet?.is_active && r.wallet?.currencies?.symbol)
      .map((r) => ({
        chain: String(r.wallet!.currencies!.symbol).toUpperCase(),
        amount: Number(r.amount || 0),
        tx: r.tx_hash,
        timestamp: r.block_time,
      }));

    return NextResponse.json(
      { ok: true, rows },
      { headers: { 'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=120' } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

