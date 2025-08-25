// app/api/public/overview/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHAINS = [
  'BTC','LTC','DOGE','ETH','OP','ARB','POL','AVAX',
  'DOT','ADA','ATOM','XRP','SOL','XLM','TRX',
] as const;

type Chain = typeof CHAINS[number];
const keyOf = (c: Chain) => `${c.toLowerCase()}_last_height`;

function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    '';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    '';

  if (!url || !key) {
    throw new Error(
      'Missing Supabase env: need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).'
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET() {
  try {
    const supabase = getSupabase();
    const keys = CHAINS.map(keyOf);

    const { data, error } = await supabase
      .from('settings')
      .select('key,value')
      .in('key', keys);

    if (error) throw error;

    const map = new Map<string, number>(
      (data ?? []).map((r: any) => [r.key, Number(r.value)])
    );

    const rows = CHAINS.map((chain) => {
      const h = map.get(keyOf(chain));
      return { chain, height: Number.isFinite(h) ? h! : null };
    });

    return NextResponse.json(
      { ok: true, total: CHAINS.length, updated: rows.filter(r => r.height != null).length, rows },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}

