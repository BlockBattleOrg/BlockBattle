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

function sb() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) throw new Error('Missing Supabase env');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET() {
  try {
    const client = sb();
    const keys = CHAINS.map(keyOf);
    const { data, error } = await client
      .from('settings')
      .select('key,value')
      .in('key', keys);

    if (error) throw error;

    const byKey = new Map<string, number>(
      (data ?? []).map((r: any) => [r.key, Number(r.value)])
    );

    const rows = CHAINS.map((chain) => {
      const height = byKey.get(keyOf(chain));
      return { chain, height: Number.isFinite(height) ? height! : null };
    });

    return NextResponse.json(
      { ok: true, total: CHAINS.length, updated: rows.filter(r => r.height != null).length, rows },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}

