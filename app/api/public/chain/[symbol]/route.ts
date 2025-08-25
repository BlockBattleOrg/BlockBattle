// app/api/public/chain/[symbol]/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED = new Set([
  'btc','ltc','doge','eth','op','arb','pol','avax',
  'dot','ada','atom','xrp','sol','xlm','trx',
]);

const keyOf = (slug: string) => `${slug}_last_height`;

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

export async function GET(_req: Request, ctx: { params: { symbol: string } }) {
  try {
    const slug = ctx.params.symbol.toLowerCase();
    if (!ALLOWED.has(slug)) {
      return NextResponse.json({ ok: false, error: 'Unknown chain' }, { status: 404 });
    }

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('settings')
      .select('value')
      .eq('key', keyOf(slug))
      .maybeSingle();

    if (error) throw error;

    const height = data?.value != null ? Number(data.value) : null;
    return NextResponse.json(
      { ok: true, chain: slug.toUpperCase(), height },
      { headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=300' } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}

