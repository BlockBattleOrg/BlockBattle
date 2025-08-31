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

type Row = {
  symbol: string;                 // e.g., BTC, MATIC, BNB
  height: number | null;          // latest known height
  updatedAt: string | null;       // ISO UTC
  status: 'OK' | 'STALE' | 'ISSUE';
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

function noStoreJson(body: any, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

export async function GET() {
  try {
    // Supabase client (service role if available; anon is fine if RLS allows read)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      (process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string,
      { auth: { persistSession: false } }
    );

    const today = utcToday();

    // 1) Today's snapshot (primary)
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

    // Aggregate latest per display symbol
    type Acc = { height: number | null; updatedAt: string | null };
    const bySymbol: Record<string, Acc> = {};

    const consume = (chainRaw: any, heightRaw: any, updatedAtRaw: any) => {
      const chain = String(chainRaw ?? '').toUpperCase();
      if (!chain) return;
      const symbol = DISPLAY_ALIAS[chain] ?? chain;
      const heightNum =
        typeof heightRaw === 'number' ? heightRaw : Number(heightRaw ?? NaN);
      const height = Number.isFinite(heightNum) ? heightNum : null;
      const updatedAt = updatedAtRaw ? new Date(updatedAtRaw).toISOString() : null;

      const prev = bySymbol[symbol];
      if (!prev) {
        bySymbol[symbol] = { height, updatedAt };
        return;
      }
      // keep most recent
      const prevT = prev.updatedAt ? Date.parse(prev.updatedAt) : -Infinity;
      const curT = updatedAt ? Date.parse(updatedAt) : -Infinity;
      if (curT > prevT) bySymbol[symbol] = { height, updatedAt };
    };

    for (const r of todayRows ?? []) {
      consume(r.chain, r.height, r.updated_at);
    }

    // 2) Fallback to latest known (any day) for symbols missing today
    const haveSymbols = new Set(Object.keys(bySymbol));
    const { data: latestAny } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at')
      .order('updated_at', { ascending: false })
      .limit(400); // safety cap

    for (const r of latestAny ?? []) {
      const raw = String(r.chain ?? '').toUpperCase();
      const symbol = DISPLAY_ALIAS[raw] ?? raw;
      if (haveSymbols.has(symbol)) continue;
      consume(r.chain, r.height, r.updated_at);
    }

    // 3) Build rows and counts
    const rows: Row[] = Object.keys(bySymbol)
      .sort()
      .map((s) => {
        const entry = bySymbol[s] ?? { height: null, updatedAt: null };
        return {
          symbol: s,
          height: entry.height,
          updatedAt: entry.updatedAt,
          status: computeStatus(entry.updatedAt),
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

    // 4) Return with multiple counter aliases (to be compatible with older UI code)
    return noStoreJson({
      ok: true,
      day: today,

      // legacy/simple fields
      ok: counts.ok,
      stale: counts.stale,
      issue: counts.issue,

      // alt names some UIs expect
      okCount: counts.ok,
      staleCount: counts.stale,
      issueCount: counts.issue,

      // structured totals
      totals: { ...counts, total: rows.length },

      rows,
      source: 'heights_daily',
    });
  } catch (e: any) {
    return noStoreJson({ ok: false, error: String(e?.message || e) }, 500);
  }
}

