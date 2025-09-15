// app/api/public/treemap/route.ts
// Returns Top 15 chains by USD sum for a given period, sourced from `aggregates_daily`.
// Query: ?period=7d|30d|ytd  (default 30d)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type UUID = string;

function getServerSupabase() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !key) throw new Error("Supabase env missing (URL or KEY).");
  return createClient(url, key, { auth: { persistSession: false } });
}

function startOfYearUTC(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}
function addDaysUTC(d: Date, delta: number) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() + delta);
  return x;
}
function toUTCDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const period = (url.searchParams.get("period") || "30d").toLowerCase();
    const now = new Date();

    let from: Date;
    if (period === "7d") from = addDaysUTC(now, -7);
    else if (period === "ytd") from = startOfYearUTC(now);
    else from = addDaysUTC(now, -30);

    const fromStr = toUTCDateString(from);
    const toStr = toUTCDateString(now);

    const supabase = getServerSupabase();

    // 1) Povuci aggregates_daily u periodu (bez join-a)
    const { data: agg, error: aggErr } = await supabase
      .from("aggregates_daily")
      .select("currency_id, day, total_amount_usd, tx_count")
      .gte("day", fromStr)
      .lte("day", toStr);

    if (aggErr) {
      return NextResponse.json({ ok: false, error: String(aggErr.message || aggErr) }, { status: 500 });
    }

    // Ako nema ničega, vrati prazan skup
    if (!agg || agg.length === 0) {
      return NextResponse.json({ ok: true, period, from: fromStr, to: toStr, items: [] });
    }

    // 2) Izvuci sve currency_id i napravi lookup id -> symbol iz currencies
    const currencyIds = Array.from(new Set(agg.map(r => r.currency_id).filter(Boolean))) as UUID[];
    let idToSymbol = new Map<UUID, string>();
    if (currencyIds.length > 0) {
      const { data: cur, error: curErr } = await supabase
        .from("currencies")
        .select("id, symbol")
        .in("id", currencyIds);
      if (curErr) {
        return NextResponse.json({ ok: false, error: String(curErr.message || curErr) }, { status: 500 });
      }
      for (const c of cur || []) idToSymbol.set(c.id as UUID, String(c.symbol));
    }

    // 3) Sumiraj po symbolu
    type AggRow = { currency_id: UUID | null; total_amount_usd: string | number | null; tx_count: number | null };
    const acc = new Map<string, { symbol: string; amountUsd: number; txCount: number }>();

    for (const r of agg as AggRow[]) {
      const sym = (r.currency_id && idToSymbol.get(r.currency_id)) || "UNKNOWN";
      const cur = acc.get(sym) || { symbol: sym, amountUsd: 0, txCount: 0 };
      cur.amountUsd += Number(r.total_amount_usd ?? 0) || 0;
      cur.txCount += Number(r.tx_count ?? 0) || 0;
      acc.set(sym, cur);
    }

    // 4) DOT/ATOM isključi, posloži i odreži Top 15
    const items = Array.from(acc.values())
      .filter(x => x.symbol !== "DOT" && x.symbol !== "ATOM")
      .sort((a, b) => b.amountUsd - a.amountUsd)
      .slice(0, 15);

    return NextResponse.json({ ok: true, period, from: fromStr, to: toStr, items });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

