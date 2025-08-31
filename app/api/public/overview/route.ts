import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---- Local types ----
type Status = 'ok' | 'stale' | 'issue';
type Row = {
  symbol: string;          // npr. 'BNB'
  name: string | null;     // npr. 'BNB Chain' ili 'BNB'
  height: number | null;   // zadnja poznata visina
  updatedAt: string | null;// ISO string
  status: Status;          // ok/stale/issue po 6h/24h
  logoUrl: string | null;  // npr. /logos/bnb.svg
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
  const url =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Alias grupe: ključ je "prikazni" simbol, vrijednost je popis
 * mogućih oznaka u bazi (varijante). Dodaj/uredi po potrebi.
 */
const SYMBOL_GROUPS: Record<string, string[]> = {
  // BNB ekosustav se često zapisuje kao BSC; želimo prikaz 'BNB'
  BNB: ['BNB', 'BSC'],
  // Polygon – ako želiš ostati na "MATIC" umjesto "POL", promijeni ovdje
  POL: ['POL', 'MATIC'],
  // Ostalo bez aliasa – dodaje se dinamički (npr. BTC: ['BTC'])
};

/** CSV override via env, e.g. ACTIVE_CHAINS="BTC,ETH,BNB,POL" */
function parseActiveChainsEnv(): string[] | null {
  const raw = process.env.ACTIVE_CHAINS;
  if (!raw) return null;
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

/** 6h / 24h pragovi */
function statusFromUpdatedAt(
  updatedAt: string | null,
  staleHours = 6,
  issueHours = 24
): Status {
  if (!updatedAt) return 'issue';
  const now = Date.now();
  const ts = new Date(updatedAt).getTime();
  const diffHr = (now - ts) / 3600000;
  if (diffHr > issueHours) return 'issue';
  if (diffHr > staleHours) return 'stale';
  return 'ok';
}

/** utility: kreira logo path: /logos/<symbol>.svg */
function logoPathFor(symbol: string): string {
  return `/logos/${symbol.toLowerCase()}.svg`;
}

/** helper: osiguraj da postoji grupa i za simbole bez aliasa */
function ensureGroupsFor(symbols: string[]) {
  for (const s of symbols) {
    if (!SYMBOL_GROUPS[s]) SYMBOL_GROUPS[s] = [s];
  }
}

/** helper: varijante (DB oznake) za traženi prikazni simbol */
function variantsFor(displaySymbol: string): string[] {
  return SYMBOL_GROUPS[displaySymbol] ?? [displaySymbol];
}

export async function GET(_req: NextRequest) {
  try {
    const supabase = getSupabase();

    // 1) Wallets -> currency ids (respect is_active)
    const { data: wallets, error: wErr } = await supabase
      .from('wallets')
      .select('currency_id, is_active');

    if (wErr) {
      return NextResponse.json<Resp>(
        { ok: false, error: `wallets: ${wErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] },
        { status: 500 }
      );
    }
    if (!Array.isArray(wallets) || wallets.length === 0) {
      return NextResponse.json<Resp>({ ok: true, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] });
    }

    const use = wallets.some((w: any) => w?.is_active === true)
      ? wallets.filter((w: any) => w?.is_active === true)
      : wallets;

    const currencyIds: string[] = Array.from(
      new Set(use.map((w: any) => w?.currency_id).filter((x: any) => x != null))
    );
    if (currencyIds.length === 0) {
      return NextResponse.json<Resp>({ ok: true, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] });
    }

    // 2) currencies -> symbols + name (+ logo path iz simbola)
    const { data: currencies, error: cErr } = await supabase
      .from('currencies')
      .select('id, symbol, name')
      .in('id', currencyIds);

    if (cErr) {
      return NextResponse.json<Resp>(
        { ok: false, error: `currencies: ${cErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] },
        { status: 500 }
      );
    }

    // display target set
    const envSymbols = parseActiveChainsEnv();
    const baseSymbols = Array.from(
      new Set((currencies ?? []).map((c: any) => String(c.symbol).toUpperCase()))
    );
    const displaySymbols = envSymbols ?? baseSymbols;

    // osiguraj alias grupe i za simbole bez definiranih aliasa
    ensureGroupsFor(displaySymbols);

    // map za meta (name, logo) po prikaznom simbolu
    const metaByDisplay: Record<string, { name: string | null; logoUrl: string }> = {};
    for (const c of currencies ?? []) {
      const sym = String(c.symbol).toUpperCase();
      const name = c.name ?? null;
      // ako npr. MATIC postoji u bazi, a prikaz želiš POL, ostavi meta za oba
      const displayForThis = Object.keys(SYMBOL_GROUPS).find((k) =>
        SYMBOL_GROUPS[k].includes(sym)
      ) ?? sym;
      metaByDisplay[displayForThis] = {
        name: name,
        logoUrl: logoPathFor(displayForThis),
      };
    }
    // metapodatke dopuni za simbole koji možda nisu pokriveni gornjom petljom
    for (const ds of displaySymbols) {
      if (!metaByDisplay[ds]) {
        metaByDisplay[ds] = { name: ds, logoUrl: logoPathFor(ds) };
      }
    }

    // 3) heights_daily – uzmi najnovije zapise u zadnja 3 dana
    //    i to za sve varijante (DB oznake) traženih prikaznih simbola.
    const allDbChains = Array.from(
      new Set(displaySymbols.flatMap((s) => variantsFor(s)))
    );

    // grubo ograničenje prozora: zadnja 3 dana (da upit bude jeftin)
    const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
    const { data: hdRows, error: hErr } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at, day')
      .gte('day', since)
      .in('chain', allDbChains)
      .order('updated_at', { ascending: false, nullsFirst: false })
      .limit(1000);

    if (hErr) {
      return NextResponse.json<Resp>(
        { ok: false, error: `heights_daily: ${hErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] },
        { status: 500 }
      );
    }

    // 4) Grupiraj po prikaznom simbolu i uzmi najnoviji zapis preko aliasa
    type Mini = { height: number | null; updatedAt: string | null };
    const latestByDisplay = new Map<string, Mini>();

    (hdRows ?? []).forEach((r: any) => {
      const dbChain = String(r.chain).toUpperCase();
      const display = Object.keys(SYMBOL_GROUPS).find((k) =>
        SYMBOL_GROUPS[k].includes(dbChain)
      ) ?? dbChain; // ako nema eksplicitne grupe, koristi isti

      if (!displaySymbols.includes(display)) return; // respektiraj ciljnu listu

      const h = r.height == null ? null : Number(r.height);
      const ts = r.updated_at ?? null;

      // prvi put je već "najnoviji" jer je upit sortiran DESC po updated_at
      if (!latestByDisplay.has(display)) {
        latestByDisplay.set(display, { height: h, updatedAt: ts });
      }
    });

    // 5) Složi rows redoslijedom displaySymbols (stabilno)
    const rows: Row[] = displaySymbols.map((sym) => {
      const entry = latestByDisplay.get(sym) ?? { height: null, updatedAt: null };
      const meta = metaByDisplay[sym] ?? { name: sym, logoUrl: logoPathFor(sym) };
      return {
        symbol: sym,
        name: meta.name,
        height: entry.height,
        updatedAt: entry.updatedAt,
        status: statusFromUpdatedAt(entry.updatedAt, 6, 24),
        logoUrl: meta.logoUrl,
      };
    });

    const okCount = rows.filter((r) => r.status === 'ok').length;
    const staleCount = rows.filter((r) => r.status === 'stale').length;
    const issueCount = rows.filter((r) => r.status === 'issue').length;

    return NextResponse.json<Resp>({
      ok: true,
      total: rows.length,
      okCount,
      staleCount,
      issueCount,
      rows,
    });
  } catch (e: any) {
    return NextResponse.json<Resp>(
      { ok: false, error: String(e?.message || e), total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] },
      { status: 500 }
    );
  }
}

