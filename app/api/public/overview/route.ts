// app/api/public/overview/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

// Freshness thresholds
const OK_HOURS = 6;
const STALE_HOURS = 24;

// DB may contain POL/BSC – display them as MATIC/BNB
const DISPLAY_ALIAS: Record<string, string> = {
  POL: 'MATIC',
  BSC: 'BNB',
};

// reverse for logo filenames (MATIC -> POL.svg, BNB -> BSC.svg)
const REVERSE_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(DISPLAY_ALIAS).map(([k, v]) => [v, k])
);

type Row = {
  symbol: string;                 // e.g., BTC, MATIC, BNB
  height: number | null;          // latest known height
  updatedAt: string | null;       // ISO UTC
  status: 'OK' | 'STALE' | 'ISSUE';
  statusClass: 'ok' | 'stale' | 'issue';
  logo: string;                   // /logo/crypto/<FILE>.svg
};

function utcToday(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function computeStatus(updatedAtISO: string | null): 'OK' | 'STALE' | 'ISSUE' {
  if (!updatedAtISO) return 'ISSUE';
  const t = Date.parse(updatedAtISO);
  if (!Number.isFinite(t)) return 'ISSUE';
  const ageHours = (Date.now() - t) / 1000 / 3600;
  if (ageHours <= OK_HOURS) return 'OK';
  if (ageHours <= STALE_HOURS) return 'STALE';
  return 'ISSUE';
}

// NOTE: logos žive u `public/logo/crypto/` (ne `logos/`)
function logoFor(symbol: string): string {
  const upper = symbol.toUpperCase();
  const alias = REVERSE_ALIAS[upper];       // MATIC -> POL, BNB -> BSC
  const file = `${alias ?? upper}.svg`;
  return `/logo/crypto/${file}`;
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

    // ---- 0) Allowlist: only symbols that exist in currencies (npr. nema ADA) ----
    const { data: curRows, error: curErr } = await supabase
      .from('currencies')
      .select('symbol');

    if (curErr) {
      return noStoreJson({ ok: false, error: 'Failed to read currencies', details: curErr.message }, 500);
    }
    const allowed = new Set<string>((curRows ?? []).map(c => String(c.symbol).toUpperCase()));

    // ---- 1) Današnji snapshot iz heights_daily (primarno) ----
    const { data: todayRows, error: todayErr } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at')
      .eq('day', today);

    if (todayErr) {
      return noStoreJson(
        { ok: false, error: 'Failed to read heights_daily (today)', details: todayErr.message },
        500
      );
    }

    type Acc = { height: number | null; updatedAt: string | null };
    const bySymbol: Record<string, Acc> = {};

    const consume = (chainRaw: any, heightRaw: any, updatedAtRaw: any) => {
      const chain = String(chainRaw ?? '').toUpperCase();
      if (!chain) return;

      const display = DISPLAY_ALIAS[chain] ?? chain; // POL->MATIC, BSC->BNB
      if (!allowed.has(display)) return;             // filtriraj unsupported (npr. ADA)

      const heightNum = typeof heightRaw === 'number' ? heightRaw : Number(heightRaw ?? NaN);
      const height = Number.isFinite(heightNum) ? heightNum : null;
      const updatedAt = updatedAtRaw ? new Date(updatedAtRaw).toISOString() : null;

      const prev = bySymbol[display];
      if (!prev) {
        bySymbol[display] = { height, updatedAt };
        return;
      }
      // zadrži noviji zapis
      const prevT = prev.updatedAt ? Date.parse(prev.updatedAt) : -Infinity;
      const curT = updatedAt ? Date.parse(updatedAt) : -Infinity;
      if (curT > prevT) bySymbol[display] = { height, updatedAt };
    };

    for (const r of todayRows ?? []) consume(r.chain, r.height, r.updated_at);

    // ---- 2) Fallback: najnoviji (bilo koji dan) za simbole koji danas fale ----
    const have = new Set(Object.keys(bySymbol));
    const { data: latestAny } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at')
      .order('updated_at', { ascending: false })
      .limit(400);

    for (const r of latestAny ?? []) {
      const raw = String(r.chain ?? '').toUpperCase();
      const display = DISPLAY_ALIAS[raw] ?? raw;
      if (!allowed.has(display)) continue;
      if (have.has(display)) continue;
      consume(r.chain, r.height, r.updated_at);
    }

    // ---- 3) Rows + counts ----
    const rows: Row[] = Object.keys(bySymbol)
      .sort()
      .map((s) => {
        const entry = bySymbol[s] ?? { height: null, updatedAt: null };
        const st = computeStatus(entry.updatedAt);
        return {
          symbol: s,
          height: entry.height,
          updatedAt: entry.updatedAt,
          status: st,
          statusClass: st.toLowerCase() as Row['statusClass'],
          logo: logoFor(s), // /logo/crypto/<SYMBOL or POL/BSC>.svg
        };
      });

    const counts = rows.reduce(
      (acc, r) => {
        if (r.status === 'OK') acc.ok += 1;
        else if (r.status === 'STALE') acc.stale += 1;
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

