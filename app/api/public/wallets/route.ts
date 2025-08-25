import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED = new Set([
  'BTC','LTC','DOGE','ETH','OP','ARB','POL','AVAX','DOT','ADA','ATOM','XRP','SOL','XLM','TRX',
]);

const SYNONYMS: Record<string, string> = {
  BITCOIN: 'BTC', LITECOIN: 'LTC', DOGECOIN: 'DOGE',
  ETHEREUM: 'ETH', OPTIMISM: 'OP', ARBITRUM: 'ARB', 'ARBITRUM ONE': 'ARB',
  POLYGON: 'POL', MATIC: 'POL', AVALANCHE: 'AVAX',
  POLKADOT: 'DOT', CARDANO: 'ADA', COSMOS: 'ATOM',
  RIPPLE: 'XRP', XRPL: 'XRP', SOLANA: 'SOL', STELLAR: 'XLM', TRON: 'TRX',
};

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env.');
  return createClient(url, key, { auth: { persistSession: false } });
}
const norm = (s: any) => (typeof s === 'string' ? s.trim() : '');
const canon = (s: string) => {
  const up = s.toUpperCase();
  return ALLOWED.has(up) ? up : (SYNONYMS[up] ?? null);
};

function explorerFor(symbol: string | null) {
  switch (symbol) {
    case 'BTC': return 'https://mempool.space/address/{address}';
    case 'LTC': return 'https://litecoinspace.org/address/{address}';
    case 'DOGE': return 'https://dogechain.info/address/{address}';
    case 'ETH': return 'https://etherscan.io/address/{address}';
    case 'OP':  return 'https://optimistic.etherscan.io/address/{address}';
    case 'ARB': return 'https://arbiscan.io/address/{address}';
    case 'POL': return 'https://polygonscan.com/address/{address}';
    case 'AVAX':return 'https://snowtrace.io/address/{address}';
    case 'DOT': return 'https://polkadot.subscan.io/account/{address}';
    case 'ADA': return 'https://cardanoscan.io/address/{address}';
    case 'ATOM':return 'https://www.mintscan.io/cosmos/account/{address}';
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
    const chainParam = searchParams.get('chain');
    const filterCanon = chainParam ? canon(chainParam) : null;
    if (chainParam && !filterCanon) {
      return NextResponse.json({ ok: false, error: 'Unknown chain' }, { status: 400 });
    }

    const sb = getSupabase();
    // join currencies preko foreign-keya currency_id
    const { data, error } = await sb
      .from('wallets')
      .select('id, address, chain, is_active, currencies:currency_id(symbol, name, decimals)')
      .eq('is_active', true);

    if (error) throw error;

    let rows = (data ?? [])
      .map((r: any) => {
        const sym = r?.currencies?.symbol ? String(r.currencies.symbol).toUpperCase() : null;
        const ch = sym ?? String(r.chain || '').toUpperCase();
        const c = canon(ch) || sym || ch;
        const addr = norm(r.address);
        if (!c || !addr) return null;
        return {
          chain: c,
          address: addr,
          memo_tag: null,
          explorer_template: explorerFor(c),
          uri_scheme: null,
        };
      })
      .filter(Boolean) as Array<{ chain: string; address: string; memo_tag: string | null; explorer_template: string | null; uri_scheme: string | null }>;

    if (filterCanon) rows = rows.filter((w) => w.chain === filterCanon);

    return NextResponse.json(
      { ok: true, wallets: rows },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600' } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

