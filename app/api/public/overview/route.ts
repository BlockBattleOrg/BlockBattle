// app/api/public/overview/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

// Status thresholds
const OK_HOURS = 6;
const STALE_HOURS = 24;

// Aliases coming from legacy naming in DB snapshots
// We display symbols, so map POL->MATIC, BSC->BNB
const DISPLAY_ALIAS: Record<string, string> = {
  POL: 'MATIC',
  BSC: 'BNB',
};

type Row = {
  symbol: string;                 // e.g., BTC, MATIC, BNB
  height: number | null;          // latest height we have
  updatedAt: string | null;       // ISO string in UTC
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
    // Supabase client (service role preferred; anon works for read if RLS allows)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL as string,
      (process.env.SUPABASE_SERVICE_ROLE_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) as string,
      { auth: { persistSession: false } }
    );

    const today = utcToday();

    // 1) Primary source: today's snapshot from heights_daily
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

    // Normalize and keep the most recent per display symbol
    type Acc = { height: number | null; updatedAt: string | null };
    const bySymbol: Record<string, Acc> = {};

    const consume = (chainRaw: any, heightRaw: any, updatedAtRaw: any) => {
      const chain = String(chainRaw ?? '').toUpperCase();
      if (!chain) return;
      const symbol = DISPLAY_ALIAS[chain] ?? chain;
      const height = typeof heightRaw === 'number' ? heightRaw : Number(heightRaw ?? NaN);
      const hVal = Number.isFinite(height) ? height : null;
      const updatedAt = updatedAtRaw ? new Date(updatedAtRaw).toISOString() : null;

      const prev = bySymbol[symbol];
      if (!prev) {
        bySymbol[symbol] = { height: hVal, updatedAt };
        return;
      }
      // keep the most recent updatedAt
      const prevT = prev.updatedAt ? Date.parse(prev.updatedAt) : -Infinity;
      const curT = updatedAt ? Date.parse(updatedAt) : -Infinity;
      if (curT > prevT) bySymbol[symbol] = { height: hVal, updatedAt };
    };

    for (const r of todayRows ?? []) {
      consume(r.chain, r.height, r.updated_at);
    }

    // 2) Fallback: if some symbols are missing today, fill them from latest known rows (any day)
    //    This ensures the UI never goes blank right after first run.
    const haveSymbols = new Set(Object.keys(bySymbol));
    const { data: latestAny, error: anyErr } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at')
      .order('updated_at', { ascending: false })
      .limit(400); // safety cap

    if (!anyErr && latestAny) {
      for (const r of latestAny) {
        const raw = String(r.chain ?? '').toUpperCase();
        const symbol = DISPLAY_ALIAS[raw] ?? raw;
        if (haveSymbols.has(symbol)) continue; // we already have today's row
        consume(r.chain, r.height, r.updated_at);
      }
    }

    // 3) Build rows and counters
    const rows: Row[] = Object.keys(bySymbol)
      .sort() // alphabetical by symbol
      .map((s) => {
        const entry = bySymbol[s] ?? { height: null, updatedAt: null };
        return {
          symbol: s,
          height: entry.height,
          updatedAt: entry.updatedAt,
          status: computeStatus(entry.updatedAt),
        };
      });

    const totals = rows.reduce(
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
      totals: { ...totals, total: rows.length },
      rows,
      source: 'heights_daily',
    });
  } catch (e: any) {
    return noStoreJson({ ok: false, error: String(e?.message || e) }, 500);
  }
}

