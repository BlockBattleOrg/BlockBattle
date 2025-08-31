// app/api/public/overview/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const OK_HOURS = 6;
const STALE_HOURS = 24;

// DB can store POL/BSC; display as MATIC/BNB
const DISPLAY_ALIAS: Record<string, string> = { POL: 'MATIC', BSC: 'BNB' };
// reverse for logo filenames (MATIC -> POL.svg, BNB -> BSC.svg)
const REVERSE_ALIAS: Record<string, string> = Object.fromEntries(
  Object.entries(DISPLAY_ALIAS).map(([k, v]) => [v, k])
);

type Row = {
  symbol: string;                    // e.g., MATIC (display symbol)
  height: number | null;
  updatedAt: string | null;
  status: 'ok' | 'stale' | 'issue';  // lowercase for CSS classes
  statusText: 'OK' | 'STALE' | 'ISSUE';
  icon: string;                      // << basename SVG-a, npr. POL, BSC, BTC ...
  // (UI obično radi src={`/logos/crypto/${icon}.svg`})
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

// basename ikone: MATIC -> POL, BNB -> BSC, ostalo = symbol
function iconBasename(displaySymbol: string): string {
  const upper = displaySymbol.toUpperCase();
  return REVERSE_ALIAS[upper] ?? upper;
}

function noStoreJson(body: any, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET() {
  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string,
      { auth: { persistSession: false } }
    );

    const today = utcToday();

    // allowlist from currencies (npr. nema ADA ako nije u currencies)
    const { data: curRows, error: curErr } = await supabase.from('currencies').select('symbol');
    if (curErr) return noStoreJson({ ok: false, error: curErr.message }, 500);
    const allowed = new Set<string>((curRows ?? []).map(c => String(c.symbol).toUpperCase()));

    // današnji snapshot
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
      const display = DISPLAY_ALIAS[chain] ?? chain; // POL->MATIC, BSC->BNB
      if (!allowed.has(display)) return;

      const num = typeof heightRaw === 'number' ? heightRaw : Number(heightRaw ?? NaN);
      const height = Number.isFinite(num) ? num : null;
      const updatedAt = updatedAtRaw ? new Date(updatedAtRaw).toISOString() : null;

      const prev = bySymbol[display];
      if (!prev || (updatedAt && Date.parse(updatedAt) > Date.parse(prev.updatedAt ?? ''))) {
        bySymbol[display] = { height, updatedAt };
      }
    };

    for (const r of todayRows ?? []) consume(r.chain, r.height, r.updated_at);

    // fallback: najnoviji (bilo koji dan) za simbole koji danas fale
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

    // rows + counts
    const rows: Row[] = Object.keys(bySymbol).sort().map((s) => {
      const entry = bySymbol[s] ?? { height: null, updatedAt: null };
      const statusText = computeStatusText(entry.updatedAt);
      return {
        symbol: s,                               // npr. MATIC
        height: entry.height,
        updatedAt: entry.updatedAt,
        statusText,                              // "OK"
        status: statusText.toLowerCase() as Row['status'], // "ok"
        icon: iconBasename(s),                   // npr. "POL" → /logos/crypto/POL.svg
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

