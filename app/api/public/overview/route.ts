import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Status = 'ok' | 'stale' | 'issue';
type Row = {
  symbol: string;        // display npr. 'MATIC', 'BNB'
  height: number | null; // latest height
  status: Status;        // ok/stale/issue (6h/24h)
  logoUrl: string | null;// /logos/crypto/<file>.svg
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

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Alias grupe: DISPLAY -> varijante u DB */
const SYMBOL_GROUPS: Record<string, string[]> = {
  BNB: ['BNB', 'BSC'],
  MATIC: ['MATIC', 'POL'],
};
function ensureGroupsFor(symbols: string[]) {
  for (const s of symbols) if (!SYMBOL_GROUPS[s]) SYMBOL_GROUPS[s] = [s];
}
function variantsFor(displaySymbol: string): string[] {
  return SYMBOL_GROUPS[displaySymbol] ?? [displaySymbol];
}

/** Za koje ime datoteke postoji logo? DISPLAY -> datoteka */
const LOGO_FILE_FOR: Record<string, string> = {
  BNB: 'BSC',    // postoji BSC.svg
  MATIC: 'POL',  // postoji POL.svg
  // ostali koriste svoje ime (npr. BTC -> BTC.svg)
};
function logoPathFor(displaySymbol: string): string {
  const fileSymbol = LOGO_FILE_FOR[displaySymbol] ?? displaySymbol;
  return `/logos/crypto/${fileSymbol.toUpperCase()}.svg`;
}

function parseActiveChainsEnv(): string[] | null {
  const raw = process.env.ACTIVE_CHAINS;
  if (!raw) return null;
  return raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

function statusFromUpdatedAt(updatedAt: string | null, staleHours = 6, issueHours = 24): Status {
  if (!updatedAt) return 'issue';
  const now = Date.now();
  const ts = new Date(updatedAt).getTime();
  const diffHr = (now - ts) / 3600000;
  if (diffHr > issueHours) return 'issue';
  if (diffHr > staleHours) return 'stale';
  return 'ok';
}

export async function GET(_req: NextRequest) {
  try {
    const supabase = getSupabase();

    // 1) wallets -> currencies (po is_active)
    const { data: wallets, error: wErr } = await supabase
      .from('wallets')
      .select('currency_id, is_active');
    if (wErr) return NextResponse.json<Resp>({ ok: false, error: `wallets: ${wErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] }, { status: 500 });
    if (!wallets?.length) return NextResponse.json<Resp>({ ok: true, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] });

    const use = wallets.some(w => w?.is_active) ? wallets.filter(w => w?.is_active) : wallets;
    const currencyIds = Array.from(new Set(use.map(w => w?.currency_id).filter(Boolean)));
    if (!currencyIds.length) return NextResponse.json<Resp>({ ok: true, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] });

    // 2) currencies -> base display set
    const { data: currencies, error: cErr } = await supabase
      .from('currencies')
      .select('id, symbol')
      .in('id', currencyIds);
    if (cErr) return NextResponse.json<Resp>({ ok: false, error: `currencies: ${cErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] }, { status: 500 });

    const envSymbols = parseActiveChainsEnv();
    const baseSymbols = Array.from(new Set((currencies ?? []).map(c => String(c.symbol).toUpperCase())));
    const displaySymbols = envSymbols ?? baseSymbols;

    ensureGroupsFor(displaySymbols);

    // 3) heights_daily – zadnja 3 dana za SVE DB varijante traženih simbola
    const allDbChains = Array.from(new Set(displaySymbols.flatMap(s => variantsFor(s))));
    const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString().slice(0, 10); // YYYY-MM-DD
    const { data: hdRows, error: hErr } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at, day')
      .gte('day', since)
      .in('chain', allDbChains)
      .order('updated_at', { ascending: false })
      .limit(1000);
    if (hErr) return NextResponse.json<Resp>({ ok: false, error: `heights_daily: ${hErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] }, { status: 500 });

    // 4) najnoviji zapis po DISPLAY simbolu (preko aliasa)
    type Mini = { height: number | null; updatedAt: string | null };
    const latestByDisplay = new Map<string, Mini>();
    for (const r of hdRows ?? []) {
      const dbChain = String(r.chain).toUpperCase();
      const display = Object.keys(SYMBOL_GROUPS).find(k => SYMBOL_GROUPS[k].includes(dbChain)) ?? dbChain;
      if (!displaySymbols.includes(display)) continue;
      if (!latestByDisplay.has(display)) {
        latestByDisplay.set(display, { height: r.height == null ? null : Number(r.height), updatedAt: r.updated_at ?? null });
      }
    }

    // 5) rows po stabilnom redoslijedu + status 6h/24h + logo path (ispravan direktorij)
    const rows: Row[] = displaySymbols.map(sym => {
      const entry = latestByDisplay.get(sym) ?? { height: null, updatedAt: null };
      return {
        symbol: sym,
        height: entry.height,
        status: statusFromUpdatedAt(entry.updatedAt, 6, 24),
        logoUrl: logoPathFor(sym),
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

