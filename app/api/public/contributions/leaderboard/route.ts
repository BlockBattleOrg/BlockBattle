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
      .select('amount, wallet:wallet_id(id, is_active, currencies:currency_id(symbol))')
      .order('wallet_id')
      .limit(5000); // plenty; adjust if needed
    if (error) throw error;

    const map = new Map<string, { total: number; count: number }>();
    for (const r of data ?? []) {
      if (!r.wallet?.is_active) continue;
      const sym = String(r.wallet?.currencies?.symbol || '').toUpperCase();
      if (!sym) continue;
      const entry = map.get(sym) || { total: 0, count: 0 };
      entry.total += Number(r.amount || 0);
      entry.count += 1;
      map.set(sym, entry);
    }

    const rows = Array.from(map.entries())
      .map(([chain, v]) => ({ chain, total: v.total, contributions: v.count }))
      .sort((a, b) => b.total - a.total);

    return NextResponse.json(
      { ok: true, rows },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

