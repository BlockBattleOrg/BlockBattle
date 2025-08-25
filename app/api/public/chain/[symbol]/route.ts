// app/api/public/chain/[symbol]/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED = new Set([
  'btc','ltc','doge','eth','op','arb','pol','avax',
  'dot','ada','atom','xrp','sol','xlm','trx',
]);

const keyH = (s: string) => `${s}_last_height`;
const keyB = (s: string) => `${s}_last_block`;

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

export async function GET(_req: Request, ctx: { params: { symbol: string } }) {
  try {
    const slug = ctx.params.symbol.toLowerCase();
    if (!ALLOWED.has(slug)) {
      return NextResponse.json({ ok: false, error: 'Unknown chain' }, { status: 404 });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('settings')
      .select('key,value')
      .in('key', [keyH(slug), keyB(slug)]);

    if (error) throw error;

    const map = new Map<string, any>((data ?? []).map((r: any) => [r.key, r.value]));
    const height = parseHeight(map.get(keyH(slug))) ?? parseHeight(map.get(keyB(slug)));

    return NextResponse.json(
      { ok: true, chain: slug.toUpperCase(), height: height ?? null },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

