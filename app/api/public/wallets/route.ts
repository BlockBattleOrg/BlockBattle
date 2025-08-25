// app/api/public/wallets/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

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

function pickChain(row: any): string | null {
  const c = row?.chain ?? row?.symbol ?? row?.currency ?? null;
  if (typeof c === 'string' && c.trim()) {
    const up = c.trim().toUpperCase();
    return ALLOWED.has(up) ? up : null;
  }
  return null;
}

function pickAddress(row: any): string {
  return String(row?.address ?? row?.addr ?? row?.wallet ?? '').trim();
}

function pickMemo(row: any): string | null {
  // tolerate different schemas
  const v =
    row?.memo_tag ??
    row?.memo ??
    row?.tag ??
    row?.destination_tag ??
    row?.payment_id ??
    null;
  return v ? String(v) : null;
}

function pickExplorerTemplate(row: any, chain: string): string | null {
  const tpl =
    row?.explorer_address_url_template ??
    row?.explorer_template ??
    row?.explorer_url ??
    row?.explorer ??
    null;
  if (tpl) return String(tpl);

  // sensible defaults by chain
  switch (chain) {
    case 'BTC': return 'https://mempool.space/address/{address}';
    case 'LTC': return 'https://litecoinspace.org/address/{address}';
    case 'DOGE': return 'https://dogechain.info/address/{address}';
    case 'ETH': return 'https://etherscan.io/address/{address}';
    case 'OP': return 'https://optimistic.etherscan.io/address/{address}';
    case 'ARB': return 'https://arbiscan.io/address/{address}';
    case 'POL': return 'https://polygonscan.com/address/{address}';
    case 'AVAX': return 'https://snowtrace.io/address/{address}';
    case 'DOT': return 'https://polkadot.subscan.io/account/{address}';
    case 'ADA': return 'https://cardanoscan.io/address/{address}';
    case 'ATOM': return 'https://www.mintscan.io/cosmos/account/{address}';
    case 'XRP': return 'https://xrpscan.com/account/{address}';
    case 'SOL': return 'https://solscan.io/address/{address}';
    case 'XLM': return 'https://stellar.expert/explorer/public/account/{address}';
    case 'TRX': return 'https://tronscan.org/#/address/{address}';
    default: return null;
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const chainParam = searchParams.get('chain')?.toUpperCase() || null;
    if (chainParam && !ALLOWED.has(chainParam)) {
      return NextResponse.json({ ok: false, error: 'Unknown chain' }, { status: 400 });
    }

    const sb = getSupabase();

    // Select '*' to avoid errors on unknown columns; RLS should allow public SELECT.
    const base = sb.from('wallets').select('*');
    const { data, error } = chainParam
      ? await base.eq('chain', chainParam)
      : await base.in('chain', Array.from(ALLOWED));

    if (error) throw error;

    const rows = (data ?? [])
      .map((r: any) => {
        const chain = pickChain(r);
        const address = pickAddress(r);
        if (!chain || !address) return null;
        return {
          chain,
          address,
          memo_tag: pickMemo(r),
          explorer_template: pickExplorerTemplate(r, chain),
          uri_scheme: r?.uri_scheme ?? null,
        };
      })
      .filter(Boolean) as Array<{
        chain: string;
        address: string;
        memo_tag: string | null;
        explorer_template: string | null;
        uri_scheme: string | null;
      }>;

    return NextResponse.json(
      { ok: true, wallets: rows },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600' } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

