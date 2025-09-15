// app/api/public/treemap/route.ts
// Returns Top-N chains by USD sum for a given period from `aggregates_daily`.
// Query:
//   ?period=7d|30d|ytd|all   (default: all)
//   ?limit=5                 (default: 5)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type UUID = string;

function getServerSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
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
    const period = (url.searchParams.get("period") || "all").toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit") || "5"))); // 1..50

    const now = new Date();
    let fromStr: string | null = null;
    let toStr: string | null = null;

    if (period !== "all") {
      let from: Date;
      if (period === "7d") from = addDaysUTC(now, -7);
      else if (period === "ytd") from = startOfYearUTC(now);
      else from = addDaysUTC(now, -30); // "30d"
      fromStr = toUTCDateString(from);
      toStr = toUTCDateString(now);
    }

    const supabase = getServerSupabase();

    // 1) aggregates_daily (bez join-a), sad čitamo i total_amount (native)
    let query = supabase
      .from("aggregates_daily")
      .select("currency_id, day, total_amount, total_amount_usd, tx_count");

    if (fromStr && toStr) {
      query = query.gte("day", fromStr).lte("day", toStr);
    }
    const { data: agg, error: aggErr } = await query;
    if (aggErr) {
      return NextResponse.json({ ok: false, error: String(aggErr.message || aggErr) }, { status: 500 });
    }

    if (!agg || agg.length === 0) {
      return NextResponse.json({
        ok: true,
        period,
        from: fromStr,
        to: toStr,
        items: [],
      });
    }

    // 2) Lookup currencies (id -> symbol)
    const currencyIds = Array.from(new Set(agg.map((r: any) => r.currency_id).filter(Boolean))) as UUID[];
    const idToSymbol = new Map<UUID, string>();
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

    // 3) Sumiraj po symbolu (USD + native + tx)
    type AggRow = {
      currency_id: UUID | null;
      total_amount_usd: string | number | null;
      total_amount: string | number | null;
      tx_count: number | null;
    };
    const acc = new Map<string, { symbol: string; amountUsd: number; amountNative: number; txCount: number }>();

    for (const r of agg as AggRow[]) {
      const sym = (r.currency_id && idToSymbol.get(r.currency_id)) || "UNKNOWN";
      const cur = acc.get(sym) || { symbol: sym, amountUsd: 0, amountNative: 0, txCount: 0 };
      cur.amountUsd += Number(r.total_amount_usd ?? 0) || 0;
      cur.amountNative += Number(r.total_amount ?? 0) || 0;
      cur.txCount += Number(r.tx_count ?? 0) || 0;
      acc.set(sym, cur);
    }

    const items = Array.from(acc.values())
      .filter((x) => x.symbol !== "DOT" && x.symbol !== "ATOM")
      .sort((a, b) => b.amountUsd - a.amountUsd)
      .slice(0, limit);

    return NextResponse.json({ ok: true, period, from: fromStr, to: toStr, items, limit });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

