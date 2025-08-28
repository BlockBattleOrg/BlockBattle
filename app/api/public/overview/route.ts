// app/api/public/overview/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHAINS = [
  'BTC','LTC','DOGE','ETH','OP','ARB','POL','AVAX',
  'DOT','BSC','ATOM','XRP','SOL','XLM','TRX',
] as const;
type Chain = typeof CHAINS[number];

const keyH = (c: Chain) => `${c.toLowerCase()}_last_height`;
const keyB = (c: Chain) => `${c.toLowerCase()}_last_block`;

// Parse height from various shapes: number | string | { n: number }
function parseHeight(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'object') {
    if (Number.isFinite(Number((v as any).n))) return Number((v as any).n);
    if (Number.isFinite(Number((v as any).value))) return Number((v as any).value);
  }
  return null;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env: need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET() {
  try {
    const supabase = getSupabase();
    const keys = [
      ...CHAINS.map(keyH),
      ...CHAINS.map(keyB),
    ];

    const { data, error } = await supabase
      .from('settings')
      .select('key,value')
      .in('key', keys);

    if (error) throw error;

    const map = new Map<string, any>((data ?? []).map((r: any) => [r.key, r.value]));

    const rows = CHAINS.map((chain) => {
      const h1 = parseHeight(map.get(keyH(chain)));
      const h2 = parseHeight(map.get(keyB(chain)));
      const height = h1 ?? h2;
      return { chain, height };
    });

    return NextResponse.json(
      { ok: true, total: CHAINS.length, updated: rows.filter(r => r.height != null).length, rows },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

