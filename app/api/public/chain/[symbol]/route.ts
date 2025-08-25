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

function sb() {
  const url = process.env.SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  if (!url || !key) throw new Error('Missing Supabase env');
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(
  _req: Request,
  ctx: { params: { symbol: string } }
) {
  try {
    const slug = ctx.params.symbol.toLowerCase();
    if (!ALLOWED.has(slug)) {
      return NextResponse.json({ ok: false, error: 'Unknown chain' }, { status: 404 });
    }

    const client = sb();
    const { data, error } = await client
      .from('settings')
      .select('value')
      .eq('key', keyOf(slug))
      .maybeSingle();

    if (error) throw error;

    const height = data?.value != null ? Number(data.value) : null;
    return NextResponse.json({ ok: true, chain: slug.toUpperCase(), height });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || 'Unexpected error' },
      { status: 500 }
    );
  }
}

