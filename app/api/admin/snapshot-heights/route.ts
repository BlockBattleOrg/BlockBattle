// app/api/admin/snapshot-heights/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

type HeightRow = {
  day: string;   // YYYY-MM-DD
  chain: string; // symbol (BTC, MATIC, BNB, ...)
  height: number;
};

// wallet-chain (lowercase) -> display symbol (uppercase)
const WALLET_CHAIN_TO_SYMBOL: Record<string, string> = {
  bitcoin: 'BTC',
  eth: 'ETH',
  solana: 'SOL',
  xrp: 'XRP',
  dogecoin: 'DOGE',
  pol: 'MATIC',
  polkadot: 'DOT',
  cosmos: 'ATOM',
  tron: 'TRX',
  litecoin: 'LTC',
  stellar: 'XLM',
  op: 'OP',
  arb: 'ARB',
  avax: 'AVAX',
  bsc: 'BNB',
};

// reverse map: symbol -> wallet-chain (lowercase)
const SYMBOL_TO_WALLET_CHAIN: Record<string, string> = Object.fromEntries(
  Object.entries(WALLET_CHAIN_TO_SYMBOL).map(([k, v]) => [v, k])
);

function utcToday(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function okJson(body: any, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function POST(req: Request) {
  try {
    // 1) auth
    const provided = req.headers.get('x-cron-secret') ?? '';
    const expected = process.env.CRON_SECRET ?? '';
    if (!expected || provided !== expected) {
      return okJson({ ok: false, error: 'Missing or invalid cron secret' }, 401);
    }

    const url = new URL(req.url);
    const day = url.searchParams.get('day') || utcToday();

    // 2) supabase client
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      (process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string,
      { auth: { persistSession: false } }
    );

    // 3) resolve symbols (priorities: ?chains → active wallets → heights_daily → currencies)
    let symbols: string[] | null = null;
    const qpChains = url.searchParams.get('chains');
    if (qpChains) {
      symbols = qpChains.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    }

    if (!symbols) {
      const { data: activeWallets } = await supabase
        .from('wallets')
        .select('chain, is_active, currency_id')
        .eq('is_active', true);

      if (activeWallets && activeWallets.length > 0) {
        const ids = Array.from(
          new Set(activeWallets.map(w => w.currency_id).filter((x): x is string => Boolean(x)))
        );
        const mapIdToSymbol = new Map<string, string>();
        if (ids.length > 0) {
          const { data: cur } = await supabase
            .from('currencies')
            .select('id, symbol')
            .in('id', ids);
          for (const c of cur ?? []) {
            if (c?.id && c?.symbol) mapIdToSymbol.set(c.id, String(c.symbol).toUpperCase());
          }
        }
        const derived = new Set<string>();
        for (const w of activeWallets) {
          if (w.currency_id && mapIdToSymbol.has(w.currency_id)) {
            derived.add(mapIdToSymbol.get(w.currency_id)!);
          } else if (w.chain) {
            const sym = WALLET_CHAIN_TO_SYMBOL[String(w.chain).toLowerCase()];
            if (sym) derived.add(sym);
          }
        }
        if (derived.size > 0) symbols = Array.from(derived);
      }
    }

    if (!symbols) {
      const { data: fromHeights } = await supabase.from('heights_daily').select('chain');
      if (fromHeights && fromHeights.length > 0) {
        symbols = Array.from(new Set(fromHeights.map(r => String(r.chain).toUpperCase()).filter(Boolean)));
      }
    }

    if (!symbols) {
      const { data: cur } = await supabase.from('currencies').select('symbol');
      if (cur && cur.length > 0) {
        symbols = cur.map(c => String(c.symbol).toUpperCase()).filter(Boolean);
      }
    }

    if (!symbols || symbols.length === 0) {
      return okJson({ ok: false, error: 'No chains resolved for snapshot' }, 400);
    }

    // 4) read heights from settings (primary) + fallbacks
    // primary keys: <SYMBOL>_last_height
    const symbolKeys = symbols.map(s => `${s}_last_height`);

    // fallback keys: <walletChain>_last_height (lowercase)
    const walletChainKeys = symbols
      .map(s => SYMBOL_TO_WALLET_CHAIN[s])
      .filter(Boolean)
      .map(c => `${c}_last_height`);

    const allKeys = Array.from(new Set([...symbolKeys, ...walletChainKeys]));

    const { data: sRows, error: sErr } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', allKeys);

    if (sErr) {
      return okJson({ ok: false, error: 'Failed to read settings', details: sErr.message }, 500);
    }

    const byKey = new Map<string, any>();
    for (const r of sRows ?? []) byKey.set(r.key, r.value);

    const nowIso = new Date().toISOString();
    const toInsert: HeightRow[] = [];
    const skipped: { symbol: string; reason: string }[] = [];

    // helper: extract numeric height from a settings value of any shape
    const readHeight = (val: any): number | null => {
      if (val == null) return null;
      if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? val : null;
      if (typeof val === 'string') {
        const n = Number(val);
        return Number.isFinite(n) && n > 0 ? n : null;
      }
      if (typeof val === 'object') {
        const candidates = [val.height, val.value, val.latest, val.last, val.h];
        for (const c of candidates) {
          const n = Number(c);
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
      return null;
    };

    // 🎯 improved fallback: look into heights_daily by symbol OR by wallet-chain alias (uppercased)
    const fallbackFromHeightsDaily = async (sym: string): Promise<number | null> => {
      const walletChain = SYMBOL_TO_WALLET_CHAIN[sym];
      const aliasUpper = walletChain ? walletChain.toUpperCase() : null;

      const candidates = aliasUpper ? [sym, aliasUpper] : [sym];

      const { data: rows } = await supabase
        .from('heights_daily')
        .select('height, updated_at, day')
        .in('chain', candidates)
        .order('updated_at', { ascending: false })
        .limit(1);

      const h = rows?.[0]?.height;
      return typeof h === 'number' && h > 0 ? h : null;
    };

    for (const sym of symbols) {
      const primaryKey = `${sym}_last_height`;
      const walletChain = SYMBOL_TO_WALLET_CHAIN[sym]; // e.g. MATIC -> pol
      const fallbackKey = walletChain ? `${walletChain}_last_height` : null;

      let height: number | null = null;

      // A) settings primary: SYMBOL_last_height
      height = readHeight(byKey.get(primaryKey));

      // B) settings fallback: walletChain_last_height
      if (height == null && fallbackKey) {
        height = readHeight(byKey.get(fallbackKey));
      }

      // C) last known in heights_daily for this symbol or its alias (e.g., POL/BSC)
      if (height == null) {
        height = await fallbackFromHeightsDaily(sym);
      }

      if (height == null) {
        skipped.push({ symbol: sym, reason: `missing ${primaryKey}${fallbackKey ? ` & ${fallbackKey}` : ''}` });
        continue;
      }

      toInsert.push({ day, chain: sym, height });
    }

    if (toInsert.length === 0) {
      return okJson({ ok: false, error: 'No valid heights in settings or fallback', day, symbols, skipped }, 400);
    }

    // 5) upsert strategy: delete same-day rows for those chains, then insert fresh
    const { error: delErr } = await supabase
      .from('heights_daily')
      .delete()
      .eq('day', day)
      .in('chain', toInsert.map(r => r.chain));
    if (delErr) {
      // non-fatal
    }

    const { error: insErr } = await supabase
      .from('heights_daily')
      .insert(
        toInsert.map(r => ({
          day: r.day,
          chain: r.chain,
          height: r.height,
          updated_at: nowIso,
        }))
      );

    if (insErr) {
      return okJson({ ok: false, error: 'Insert failed', details: insErr.message, day, rows: toInsert.length }, 500);
    }

    return okJson({ ok: true, day, upserted: toInsert.length, skipped, symbols });
  } catch (e: any) {
    return okJson({ ok: false, error: String(e?.message || e) }, 500);
  }
}

