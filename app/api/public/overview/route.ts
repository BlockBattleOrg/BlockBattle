import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---- Local types ----
type Status = 'ok' | 'stale' | 'issue';
type Row = {
  symbol: string;          // display symbol e.g. 'MATIC', 'BNB'
  name: string | null;     // optional friendly name
  height: number | null;   // latest known height
  status: Status;          // ok/stale/issue (6h/24h)
  logoUrl: string | null;  // /logo/crypto/<symbol>.svg
};
type Resp = {
  ok: boolean;
  total: number;
  okCount: number;
  staleCount: number;
  issueCount: number;
  rows: Row[];
  error?: string;
};
// ---------------------

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Alias grupe: ključ je DISPLAY simbol, vrijednost su varijante kako se može pojaviti u DB.
 * Važno: ovdje MATIC prikazuje i POL iz baze, BNB prikazuje i BSC.
 */
const SYMBOL_GROUPS: Record<string, string[]> = {
  BNB: ['BNB', 'BSC'],
  MATIC: ['MATIC', 'POL'],
  // Ostalo bez aliasa – dinamički ćemo dodati u ensureGroupsFor()
};

function parseActiveChainsEnv(): string[] | null {
  const raw = process.env.ACTIVE_CHAINS;
  if (!raw) return null;
  return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

/** 6h / 24h pragovi */
function statusFromUpdatedAt(updatedAt: string | null, staleHours = 6, issueHours = 24): Status {
  if (!updatedAt) return 'issue';
  const now = Date.now();
  const ts = new Date(updatedAt).getTime();
  const diffHr = (now - ts) / 3600000;
  if (diffHr > issueHours) return 'issue';
  if (diffHr > staleHours) return 'stale';
  return 'ok';
}

/** path do SVG loga u public folderu */
function logoPathFor(symbol: string): string {
  return `/logo/crypto/${symbol.toLowerCase()}.svg`;
}

/** Dodaj grupe za simbole bez aliasa */
function ensureGroupsFor(symbols: string[]) {
  for (const s of symbols) {
    if (!SYMBOL_GROUPS[s]) SYMBOL_GROUPS[s] = [s];
  }
}

/** Vrati DB varijante za display symbol */
function variantsFor(displaySymbol: string): string[] {
  return SYMBOL_GROUPS[displaySymbol] ?? [displaySymbol];
}

export async function GET(_req: NextRequest) {
  try {
    const supabase = getSupabase();

    // 1) Wallets -> currencies respecting is_active
    const { data: wallets, error: wErr } = await supabase
      .from('wallets')
      .select('currency_id, is_active');

    if (wErr) {
      return NextResponse.json<Resp>({ ok: false, error: `wallets: ${wErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] }, { status: 500 });
    }
    if (!Array.isArray(wallets) || wallets.length === 0) {
      return NextResponse.json<Resp>({ ok: true, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] });
    }

    const use = wallets.some((w: any) => w?.is_active === true)
      ? wallets.filter((w: any) => w?.is_active === true)
      : wallets;

    const currencyIds: string[] = Array.from(new Set(use.map((w: any) => w?.currency_id).filter((x: any) => x != null)));
    if (currencyIds.length === 0) {
      return NextResponse.json<Resp>({ ok: true, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] });
    }

    // 2) currencies -> display meta (symbol, name)
    const { data: currencies, error: cErr } = await supabase
      .from('currencies')
      .select('id, symbol, name')
      .in('id', currencyIds);

    if (cErr) {
      return NextResponse.json<Resp>({ ok: false, error: `currencies: ${cErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] }, { status: 500 });
    }

    const envSymbols = parseActiveChainsEnv();
    const baseSymbols = Array.from(new Set((currencies ?? []).map((c: any) => String(c.symbol).toUpperCase())));
    const displaySymbols = envSymbols ?? baseSymbols;

    ensureGroupsFor(displaySymbols);

    // meta po display symbolu
    const metaByDisplay: Record<string, { name: string | null; logoUrl: string }> = {};
    for (const c of currencies ?? []) {
      const sym = String(c.symbol).toUpperCase();
      const display = Object.keys(SYMBOL_GROUPS).find((k) => SYMBOL_GROUPS[k].includes(sym)) ?? sym;
      metaByDisplay[display] = { name: c.name ?? display, logoUrl: logoPathFor(display) };
    }
    for (const ds of displaySymbols) {
      if (!metaByDisplay[ds]) metaByDisplay[ds] = { name: ds, logoUrl: logoPathFor(ds) };
    }

    // 3) heights_daily -> uzmi najnovije u zadnja 3 dana za sve DB varijante traženih display simbola
    const allDbChains = Array.from(new Set(displaySymbols.flatMap((s) => variantsFor(s))));
    const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const { data: hdRows, error: hErr } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at, day')
      .gte('day', since)
      .in('chain', allDbChains)
      .order('updated_at', { ascending: false })
      .limit(1000);

    if (hErr) {
      return NextResponse.json<Resp>({ ok: false, error: `heights_daily: ${hErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] }, { status: 500 });
    }

    // 4) mapiraj na DISPLAY simbol i uzmi najnoviji zapis po DISPLAY simbolu
    type Mini = { height: number | null; updatedAt: string | null };
    const latestByDisplay = new Map<string, Mini>();
    (hdRows ?? []).forEach((r: any) => {
      const dbChain = String(r.chain).toUpperCase();
      const display = Object.keys(SYMBOL_GROUPS).find((k) => SYMBOL_GROUPS[k].includes(dbChain)) ?? dbChain;
      if (!displaySymbols.includes(display)) return; // respektiraj finalni popis
      if (!latestByDisplay.has(display)) {
        latestByDisplay.set(display, {
          height: r.height == null ? null : Number(r.height),
          updatedAt: r.updated_at ?? null,
        });
      }
    });

    // 5) složi rows u stabilnom redoslijedu displaySymbols
    const rows: Row[] = displaySymbols.map((sym) => {
      const entry = latestByDisplay.get(sym) ?? { height: null, updatedAt: null };
      const meta = metaByDisplay[sym] ?? { name: sym, logoUrl: logoPathFor(sym) };
      return {
        symbol: sym,
        name: meta.name,
        height: entry.height,
        status: statusFromUpdatedAt(entry.updatedAt, 6, 24),
        logoUrl: meta.logoUrl,
      };
    });

    const okCount = rows.filter(r => r.status === 'ok').length;
    const staleCount = rows.filter(r => r.status === 'stale').length;
    const issueCount = rows.filter(r => r.status === 'issue').length;

    return NextResponse.json<Resp>({ ok: true, total: rows.length, okCount, staleCount, issueCount, rows });
  } catch (e: any) {
    return NextResponse.json<Resp>({ ok: false, error: String(e?.message || e), total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] }, { status: 500 });
  }
}

