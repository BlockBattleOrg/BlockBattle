// app/api/admin/snapshot-heights/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Ensure this route is never cached at the edge
export const dynamic = 'force-dynamic';

type HeightRow = {
  day: string;      // YYYY-MM-DD
  chain: string;    // symbol, e.g. BTC, MATIC, BNB
  height: number;
};

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

function utcToday(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = `${d.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${d.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toSymbolMaybeFromWalletChain(chain: string | null | undefined): string | null {
  if (!chain) return null;
  const s = WALLET_CHAIN_TO_SYMBOL[String(chain).toLowerCase()];
  return s ?? null;
}

function okJson(body: any, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(req: Request) {
  try {
    // --- auth via cron secret
    const provided = req.headers.get('x-cron-secret') ?? '';
    const expected = process.env.CRON_SECRET ?? '';
    if (!expected || provided !== expected) {
      return okJson({ ok: false, error: 'Missing or invalid cron secret' }, 401);
    }

    const url = new URL(req.url);
    const day = url.searchParams.get('day') || utcToday();

    // Supabase client (service role is ideal, anon also works for these selects if RLS permits)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      (process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string,
      { auth: { persistSession: false } }
    );

    // --- 1) desired chain list (symbols) from ?chains=BTC,ETH,...
    const qpChains = url.searchParams.get('chains');
    let symbols: string[] | null = null;
    if (qpChains) {
      symbols = qpChains
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    }

    // --- 2) else: from active wallets (join to currencies for symbol)
    if (!symbols) {
      // try join via currency_id to currencies.symbol
      const { data: activeWallets, error: wErr } = await supabase
        .from('wallets')
        .select('chain, is_active, currency_id')
        .eq('is_active', true);

      if (wErr) {
        // do not fail snapshot on read error; continue to next source
        // console.error('wallets read error', wErr);
      } else if (activeWallets && activeWallets.length > 0) {
        // fetch symbols for these currency_ids
        const ids = Array.from(
          new Set(
            activeWallets
              .map((w) => w.currency_id)
              .filter((x): x is string => Boolean(x))
          )
        );

        let mapIdToSymbol = new Map<string, string>();
        if (ids.length > 0) {
          const { data: currencies } = await supabase
            .from('currencies')
            .select('id, symbol')
            .in('id', ids);

          if (currencies) {
            for (const c of currencies) {
              if (c?.id && c?.symbol) mapIdToSymbol.set(c.id, String(c.symbol).toUpperCase());
            }
          }
        }

        // Derive final symbols:
        const derived = new Set<string>();
        for (const w of activeWallets) {
          // 1) prefer explicit currencies.symbol
          if (w.currency_id && mapIdToSymbol.has(w.currency_id)) {
            derived.add(mapIdToSymbol.get(w.currency_id)!);
            continue;
          }
          // 2) fallback via wallet chain alias map
          const sym = toSymbolMaybeFromWalletChain(w.chain);
          if (sym) derived.add(sym);
        }

        if (derived.size > 0) {
          symbols = Array.from(derived);
        }
      }
    }

    // --- 3) else: fallback to distinct heights_daily.chain
    if (!symbols) {
      const { data: fromHeights } = await supabase
        .from('heights_daily')
        .select('chain');

      if (fromHeights && fromHeights.length > 0) {
        symbols = Array.from(
          new Set(fromHeights.map((r: any) => String(r.chain).toUpperCase()).filter(Boolean))
        );
      }
    }

    // --- 4) else: fallback to all currencies.symbol
    if (!symbols) {
      const { data: cur } = await supabase.from('currencies').select('symbol');
      if (cur && cur.length > 0) {
        symbols = cur.map((c: any) => String(c.symbol).toUpperCase()).filter(Boolean);
      }
    }

    if (!symbols || symbols.length === 0) {
      return okJson({ ok: false, error: 'No chains resolved for snapshot' }, 400);
    }

    // Prepare: read <SYMBOL>_last_height from settings
    const keys = symbols.map((s) => `${s}_last_height`);
    const { data: settings, error: sErr } = await supabase
      .from('settings')
      .select('key, value')
      .in('key', keys);

    if (sErr) {
      return okJson({ ok: false, error: 'Failed to read settings', details: sErr.message }, 500);
    }

    // Build insert rows
    const byKey = new Map<string, any>();
    for (const row of settings ?? []) {
      byKey.set(row.key, row.value);
    }

    const nowIso = new Date().toISOString();
    const toInsert: HeightRow[] = [];
    const skipped: { symbol: string; reason: string }[] = [];

    for (const sym of symbols) {
      const key = `${sym}_last_height`;
      const val = byKey.get(key);

      const height = Number(
        val?.height ?? val?.value ?? val ?? Number.NaN
      );
      if (!Number.isFinite(height) || height <= 0) {
        skipped.push({ symbol: sym, reason: `missing ${key}` });
        continue;
      }

      toInsert.push({ day, chain: sym, height });
    }

    if (toInsert.length === 0) {
      return okJson({
        ok: false,
        error: 'No valid heights found in settings',
        day,
        symbols,
        skipped,
      }, 400);
    }

    // Upsert rows one shot. PostgREST cannot express ON CONFLICT WHERE clause,
    // so we do a small RPC or multi-step. Simplest: delete+insert for that day/chain set,
    // or use supabase-js upsert (it maps to INSERT..ON CONFLICT DO UPDATE without WHERE).
    // We'll accept "last write wins" since this route is single-writer, but we keep updated_at fresh.

    // Delete existing rows for (day, chains) to avoid stale data.
    const { error: delErr } = await supabase
      .from('heights_daily')
      .delete()
      .eq('day', day)
      .in('chain', toInsert.map((r) => r.chain));

    if (delErr) {
      // non-fatal; continue with insert
    }

    // Insert fresh snapshot
    const { error: insErr } = await supabase
      .from('heights_daily')
      .insert(
        toInsert.map((r) => ({
          day: r.day,
          chain: r.chain,
          height: r.height,
          updated_at: nowIso,
        }))
      );

    if (insErr) {
      return okJson({ ok: false, error: 'Insert failed', details: insErr.message, day, rows: toInsert.length }, 500);
    }

    return okJson({
      ok: true,
      day,
      upserted: toInsert.length,
      skipped,
      symbols,
    });
  } catch (e: any) {
    return okJson({ ok: false, error: String(e?.message || e) }, 500);
  }
}

