// app/api/public/wallets/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Allowed chains to avoid leaking unrelated data
const ALLOWED = new Set([
  'BTC','LTC','DOGE','ETH','OP','ARB','POL','AVAX',
  'DOT','ADA','ATOM','XRP','SOL','XLM','TRX',
]);

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env.');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const chainParam = searchParams.get('chain')?.toUpperCase() || null;

    if (chainParam && !ALLOWED.has(chainParam)) {
      return NextResponse.json({ ok: false, error: 'Unknown chain' }, { status: 400 });
    }

    const sb = getSupabase();
    const query = sb
      .from('wallets')
      .select('chain,address,memo_tag,explorer_address_url_template,uri_scheme');

    const { data, error } = chainParam
      ? await query.eq('chain', chainParam)
      : await query.in('chain', Array.from(ALLOWED));

    if (error) throw error;

    const rows = (data ?? []).map((w: any) => ({
      chain: String(w.chain || '').toUpperCase(),
      address: String(w.address || w.addr || w.wallet || ''),
      memo_tag: w.memo_tag ?? null,
      explorer_template: w.explorer_address_url_template ?? null,
      uri_scheme: w.uri_scheme ?? null,
    }));

    return NextResponse.json(
      { ok: true, wallets: rows },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600' } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

