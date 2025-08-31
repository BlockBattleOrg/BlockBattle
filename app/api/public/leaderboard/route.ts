// app/api/public/leaderboard/route.ts
// Public leaderboard: native totals + USD totals.
// - No created_at dependency (pages by id)
// - Env resolution matches your previous working helper (service-role preferred, anon fallback)

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 2000;
type OrderKey = "native" | "usd";
type Row = { chain: string; total: number; usd_total: number; contributions: number };

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  if (!url || !key) {
    throw new Error(
      "Missing Supabase env: need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)."
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const orderParam = (url.searchParams.get("order") || "native").toLowerCase() as OrderKey;
    const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);

    const order: OrderKey = orderParam === "usd" ? "usd" : "native";
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;

    const supabase = getSupabase();

    // 1) Read contributions in pages (id asc), without created_at
    type Contrib = { id: number; wallet_id: string; amount: number | null; amount_usd: number | null };
    const contribs: Contrib[] = [];
    let start = 0;

    while (true) {
      const { data, error } = await supabase
        .from("contributions")
        .select("id, wallet_id, amount, amount_usd")
        .order("id", { ascending: true })
        .range(start, start + PAGE_SIZE - 1);

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      if (!data || data.length === 0) break;

      for (const r of data) {
        contribs.push({
          id: r.id,
          wallet_id: r.wallet_id,
          amount: typeof r.amount === "number" ? r.amount : null,
          amount_usd: typeof r.amount_usd === "number" ? r.amount_usd : null,
        });
      }

      if (data.length < PAGE_SIZE) break;
      start += PAGE_SIZE;
      if (start > 500000) break; // safety guard
    }

    if (contribs.length === 0) {
      return NextResponse.json({ ok: true, order, total: 0, rows: [] });
    }

    // 2) wallets -> currency_id
    const walletIds = Array.from(new Set(contribs.map((c) => c.wallet_id).filter(Boolean))) as string[];
    type Wallet = { id: string; currency_id: string | number | null };
    const { data: wallets, error: wErr } = await supabase
      .from("wallets")
      .select("id, currency_id")
      .in("id", walletIds);
    if (wErr) return NextResponse.json({ ok: false, error: wErr.message }, { status: 500 });

    const walletToCurrency: Record<string, string | number> = {};
    for (const w of (wallets || []) as Wallet[]) {
      if (w?.id && w.currency_id != null) walletToCurrency[w.id] = w.currency_id;
    }

    const currencyIds = Array.from(new Set(Object.values(walletToCurrency)));

    // 3) currencies -> symbol
    type Currency = { id: string | number; symbol: string | null };
    const { data: currencies, error: cErr } = await supabase
      .from("currencies")
      .select("id, symbol")
      .in("id", currencyIds);
    if (cErr) return NextResponse.json({ ok: false, error: cErr.message }, { status: 500 });

    const currencyToSymbol: Record<string | number, string> = {};
    for (const c of (currencies || []) as Currency[]) {
      if (c?.id != null && c?.symbol) currencyToSymbol[c.id] = c.symbol.toUpperCase();
    }

    // 4) Aggregate
    const agg: Record<string, Row> = {};
    for (const r of contribs) {
      const curId = walletToCurrency[r.wallet_id];
      const symbol = currencyToSymbol[curId];
      if (!symbol) continue;

      const entry = (agg[symbol] ||= { chain: symbol, total: 0, usd_total: 0, contributions: 0 });
      if (typeof r.amount === "number" && Number.isFinite(r.amount)) entry.total += r.amount;
      if (typeof r.amount_usd === "number" && Number.isFinite(r.amount_usd)) entry.usd_total += r.amount_usd;
      entry.contributions += 1;
    }

    let rows = Object.values(agg);

    // 5) Sort & limit
    if (order === "usd") rows.sort((a, b) => (b.usd_total || 0) - (a.usd_total || 0));
    else rows.sort((a, b) => (b.total || 0) - (a.total || 0));
    rows = rows.slice(0, limit);

    return NextResponse.json({
      ok: true,
      order,
      total: rows.length,
      rows: rows.map((r) => ({
        chain: r.chain,
        total: r.total,
        contributions: r.contributions,
        usd_total: r.usd_total,
      })),
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

