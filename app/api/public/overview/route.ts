// app/api/public/overview/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const OK_HOURS = 6;
const STALE_HOURS = 24;

// DB može imati POL/BSC; za prikaz želimo MATIC/BNB
const DISPLAY_ALIAS: Record<string, string> = { POL: 'MATIC', BSC: 'BNB' };
// obrnuto za datoteke ikona (MATIC -> POL.svg, BNB -> BSC.svg)
const REVERSE_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(DISPLAY_ALIAS).map(([k, v]) => [v, k])
);

type Row = {
  symbol: string;                    // npr. MATIC (za UI prikaz)
  height: number | null;
  updatedAt: string | null;
  // status za CSS klase (lowercase)
  status: 'ok' | 'stale' | 'issue';
  // status za label (uppercase)
  statusText: 'OK' | 'STALE' | 'ISSUE';

  // —— IKONE (više naziva za potpunu kompatibilnost) ——
  icon: string;                      // basename SVG-a (BTC, ETH, POL, BSC, …)
  logo: string;                      // /logos/crypto/<icon>.svg
  iconUrl: string;                   // isto kao logo
  logoUrl: string;                   // isto kao logo
  image: string;                     // isto kao logo
  img: string;                       // isto kao logo
};

function utcToday(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function computeStatusText(updatedAtISO: string | null): 'OK' | 'STALE' | 'ISSUE' {
  if (!updatedAtISO) return 'ISSUE';
  const t = Date.parse(updatedAtISO);
  if (!Number.isFinite(t)) return 'ISSUE';
  const ageHours = (Date.now() - t) / 1000 / 3600;
  if (ageHours <= OK_HOURS) return 'OK';
  if (ageHours <= STALE_HOURS) return 'STALE';
  return 'ISSUE';
}

// basename SVG-a: MATIC -> POL, BNB -> BSC, ostalo = symbol
function iconBasename(displaySymbol: string): string {
  const upper = displaySymbol.toUpperCase();
  return REVERSE_ALIAS[upper] ?? upper;
}

function noStoreJson(body: any, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      (process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string,
      { auth: { persistSession: false } }
    );

    const today = utcToday();

    // Allowlist simbola iz currencies (npr. nema ADA ako nije tamo)
    const { data: curRows, error: curErr } = await supabase
      .from('currencies')
      .select('symbol');
    if (curErr) return noStoreJson({ ok: false, error: curErr.message }, 500);

    const allowed = new Set<string>((curRows ?? []).map(c => String(c.symbol).toUpperCase()));

    // Današnji snapshot iz heights_daily (primarno)
    const { data: todayRows, error: todayErr } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at')
      .eq('day', today);
    if (todayErr) return noStoreJson({ ok: false, error: todayErr.message }, 500);

    type Acc = { height: number | null; updatedAt: string | null };
    const bySymbol: Record<string, Acc> = {};

    const consume = (chainRaw: any, heightRaw: any, updatedAtRaw: any) => {
      const chain = String(chainRaw ?? '').toUpperCase();
      if (!chain) return;

      // POL->MATIC, BSC->BNB za UI prikaz
      const display = DISPLAY_ALIAS[chain] ?? chain;
      if (!allowed.has(display)) return;

      const hNum = typeof heightRaw === 'number' ? heightRaw : Number(heightRaw ?? NaN);
      const height = Number.isFinite(hNum) ? hNum : null;
      const updatedAt = updatedAtRaw ? new Date(updatedAtRaw).toISOString() : null;

      const prev = bySymbol[display];
      if (!prev || (updatedAt && Date.parse(updatedAt) > Date.parse(prev.updatedAt ?? ''))) {
        bySymbol[display] = { height, updatedAt };
      }
    };

    for (const r of todayRows ?? []) consume(r.chain, r.height, r.updated_at);

    // Fallback: najnoviji zapis (bilo koji dan) za simbole koji danas fale
    const have = new Set(Object.keys(bySymbol));
    const { data: latestAny } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at')
      .order('updated_at', { ascending: false })
      .limit(400);

    for (const r of latestAny ?? []) {
      const raw = String(r.chain ?? '').toUpperCase();
      const display = DISPLAY_ALIAS[raw] ?? raw;
      if (!allowed.has(display) || have.has(display)) continue;
      consume(r.chain, r.height, r.updated_at);
    }

    // Rows + counts
    const rows: Row[] = Object.keys(bySymbol).sort().map((s) => {
      const entry = bySymbol[s] ?? { height: null, updatedAt: null };
      const statusText = computeStatusText(entry.updatedAt);
      const icon = iconBasename(s);
      const path = `/logos/crypto/${icon}.svg`;
      return {
        symbol: s,
        height: entry.height,
        updatedAt: entry.updatedAt,
        statusText,
        status: statusText.toLowerCase() as Row['status'],
        icon,                 // npr. POL za MATIC, BSC za BNB
        logo: path,           // svi aliasi ispod vode na isto
        iconUrl: path,
        logoUrl: path,
        image: path,
        img: path,
      };
    });

    const counts = rows.reduce(
      (acc, r) => {
        if (r.status === 'ok') acc.ok += 1;
        else if (r.status === 'stale') acc.stale += 1;
        else acc.issue += 1;
        return acc;
      },
      { ok: 0, stale: 0, issue: 0 }
    );

    return noStoreJson({
      ok: true,
      day: today,
      counts: { ...counts, total: rows.length },
      okCount: counts.ok,
      staleCount: counts.stale,
      issueCount: counts.issue,
      totals: { ...counts, total: rows.length },
      rows,
      source: 'heights_daily',
    });
  } catch (e: any) {
    return noStoreJson({ ok: false, error: String(e?.message || e) }, 500);
  }
}

