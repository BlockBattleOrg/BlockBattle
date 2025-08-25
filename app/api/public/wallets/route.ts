// app/api/public/wallets/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED = new Set([
  'BTC','LTC','DOGE','ETH','OP','ARB','POL','AVAX',
  'DOT','ADA','ATOM','XRP','SOL','XLM','TRX',
]);

// Common synonyms -> canonical chain ticker
const SYNONYMS: Record<string, string> = {
  // EVM L2 / alt L1
  ETHEREUM: 'ETH',
  OPTIMISM: 'OP',
  'ARBITRUM ONE': 'ARB',
  ARBITRUM: 'ARB',
  POLYGON: 'POL',
  MATIC: 'POL',
  AVALANCHE: 'AVAX',

  // UTXO
  BITCOIN: 'BTC',
  LITECOIN: 'LTC',
  DOGECOIN: 'DOGE',

  // Others
  POLKADOT: 'DOT',
  CARDANO: 'ADA',
  COSMOS: 'ATOM',
  RIPPLE: 'XRP',
  XRPL: 'XRP',
  SOLANA: 'SOL',
  STELLAR: 'XLM',
  TRON: 'TRX',
};

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env.');
  return createClient(url, key, { auth: { persistSession: false } });
}

function normalizeChain(x: any): string | null {
  const raw = typeof x === 'string' ? x.trim() : '';
  if (!raw) return null;
  const up = raw.toUpperCase();
  const canon = SYNONYMS[up] ?? up;
  return ALLOWED.has(canon) ? canon : null;
}

function pickChain(row: any): string | null {
  return normalizeChain(row?.chain ?? row?.symbol ?? row?.currency ?? null);
}

function pickAddress(row: any): string {
  // tolerate different schemas
  return String(row?.address ?? row?.addr ?? row?.wallet ?? row?.text ?? '').trim();
}

function pickMemo(row: any): string | null {
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

  // sensible defaults
  switch (chain) {
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

// Optional ENV fallback: e.g. POL_WALLET_ADDRESS
function envWalletFor(chain: string): string | null {
  const key = `${chain}_WALLET_ADDRESS`;
  const v = (process.env as any)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const chainParam = searchParams.get('chain');
    const chainFilter = chainParam ? normalizeChain(chainParam) : null;
    if (chainParam && !chainFilter) {
      return NextResponse.json({ ok: false, error: 'Unknown chain' }, { status: 400 });
    }

    const sb = getSupabase();

    // Fetch all and filter in code (wallets table is tiny; avoids case/locale pitfalls)
    const { data, error } = await sb.from('wallets').select('*');
    if (error) throw error;

    let rows = (data ?? [])
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

    if (chainFilter) {
      rows = rows.filter((w) => w.chain === chainFilter);
      if (rows.length === 0) {
        const addr = envWalletFor(chainFilter);
        if (addr) {
          rows.push({
            chain: chainFilter,
            address: addr,
            memo_tag: null,
            explorer_template: pickExplorerTemplate({}, chainFilter),
            uri_scheme: null,
          });
        }
      }
    } else if (rows.length === 0) {
      // no filter: include any ENV fallbacks
      for (const c of ALLOWED) {
        const addr = envWalletFor(c);
        if (addr) {
          rows.push({
            chain: c,
            address: addr,
            memo_tag: null,
            explorer_template: pickExplorerTemplate({}, c),
            uri_scheme: null,
          });
        }
      }
    }

    return NextResponse.json(
      { ok: true, wallets: rows },
      { headers: { 'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=600' } }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

