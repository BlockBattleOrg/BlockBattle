// app/api/public/treemap/route.ts
// Returns Top 15 chains by USD sum for a given period, sourced from `aggregates_daily`.
// Query: ?period=7d|30d|ytd  (default 30d)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type UUID = string;

function getAnonSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_ANON_KEY!; // RLS should allow read
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
  const url = new URL(req.url);
  const period = (url.searchParams.get("period") || "30d").toLowerCase();
  const now = new Date();

  let from: Date;
  if (period === "7d") from = addDaysUTC(now, -7);
  else if (period === "ytd") from = startOfYearUTC(now);
  else from = addDaysUTC(now, -30);

  const fromStr = toUTCDateString(from);
  const toStr = toUTCDateString(now);

  const supabase = getAnonSupabase();

  // Povuci sve redove iz aggregates_daily u periodu + pridruženu valutu radi simbola
  const { data, error } = await supabase
    .from("aggregates_daily")
    .select("currency_id, day, total_amount_usd, tx_count, currencies!inner(symbol)") // FK na currencies
    .gte("day", fromStr)
    .lte("day", toStr);

  if (error) {
    return NextResponse.json({ ok: false, error: String(error.message || error) }, { status: 500 });
  }

  // Sumarizacija po symbolu
  type Row = { currency_id: UUID; day: string; total_amount_usd: string | number; tx_count: number; currencies: { symbol: string } };
  const acc = new Map<string, { symbol: string; amountUsd: number; txCount: number }>();

  for (const r of (data || []) as Row[]) {
    const sym = r.currencies?.symbol || "UNKNOWN";
    const cur = acc.get(sym) || { symbol: sym, amountUsd: 0, txCount: 0 };
    cur.amountUsd += Number(r.total_amount_usd ?? 0) || 0;
    cur.txCount += Number(r.tx_count ?? 0) || 0;
    acc.set(sym, cur);
  }

  // DOT/ATOM filter u UI sloju — ali možeš isključiti i ovdje ako želiš:
  const items = Array.from(acc.values())
    .filter(x => x.symbol !== "DOT" && x.symbol !== "ATOM")
    .sort((a, b) => b.amountUsd - a.amountUsd)
    .slice(0, 15);

  return NextResponse.json({ ok: true, period, from: fromStr, to: toStr, items });
}

