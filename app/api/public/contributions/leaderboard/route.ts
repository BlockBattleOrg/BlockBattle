// app/api/public/contributions/leaderboard/route.ts
// Public leaderboard with native totals AND USD totals.
// Safe for public use (uses anon key). No DB schema changes required.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";         // stable env access for serverless
export const dynamic = "force-dynamic";  // always fresh

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// How many days back to include (prevents unbounded scans on very large tables)
const DEFAULT_SINCE_DAYS = parseInt(process.env.LEADERBOARD_SINCE_DAYS || "365", 10);

// Page size for contributions scan
const PAGE_SIZE = 2000;

// Order options
type OrderKey = "native" | "usd";

type Row = {
  chain: string;           // symbol, e.g. 'ETH'
  total: number;           // sum of amount (native units)
  usd_total: number;       // sum of amount_usd (USD)
  contributions: number;   // count of rows
};

export async function GET(req: NextRequest) {
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      return NextResponse.json(
        { ok: false, error: "Server misconfigured: missing Supabase env" },
        { status: 500 }
      );
    }

    const url = new URL(req.url);
    const orderParam = (url.searchParams.get("order") || "native").toLowerCase() as OrderKey;
    const limitParam = parseInt(url.searchParams.get("limit") || "50", 10);
    const sinceDays = parseInt(url.searchParams.get("sinceDays") || String(DEFAULT_SINCE_DAYS), 10);

    const order: OrderKey = orderParam === "usd" ? "usd" : "native";
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 50;

    const sinceISO = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

    // 1) Pull wallet → currency map
    //    (small table; fetch all ids we might need later, but to be safe we only fetch needed ones)
    //    We'll first collect contributions (wallet_ids), then fetch only those wallets and their currencies.

    // 1a) Scan contributions in pages to collect wallet_ids + amounts
    type Contrib = { wallet_id: string; amount: number | null; amount_usd: number | null };
    const contribs: Contrib[] = [];
    let start = 0;
    while (true) {
      const { data, error } = await supabase
        .from("contributions")
        .select("wallet_id, amount, amount_usd, created_at")
        .gte("created_at", sinceISO)
        .order("id", { ascending: true })
        .range(start, start + PAGE_SIZE - 1);

      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }
      if (!data || data.length === 0) break;

      // Push minimized rows
      for (const r of data) {
        contribs.push({
          wallet_id: r.wallet_id,
          amount: typeof r.amount === "number" ? r.amount : null,
          amount_usd: typeof r.amount_usd === "number" ? r.amount_usd : null,
        });
      }

      if (data.length < PAGE_SIZE) break;
      start += PAGE_SIZE;

      // safety stop (in case of misconfigured sinceDays)
      if (start > 500000) break;
    }

    if (contribs.length === 0) {
      return NextResponse.json({ ok: true, total: 0, updated: 0, rows: [] });
    }

    const walletIds = Array.from(new Set(contribs.map(c => c.wallet_id).filter(Boolean))) as string[];

    // 2) Fetch just the wallets we need → currency_id
    type Wallet = { id: string; currency_id: string | number | null };
    const { data: wallets, error: wErr } = await supabase
      .from("wallets")
      .select("id, currency_id")
      .in("id", walletIds);

    if (wErr) {
      return NextResponse.json({ ok: false, error: wErr.message }, { status: 500 });
    }

    const walletToCurrency: Record<string, string | number> = {};
    for (const w of (wallets || []) as Wallet[]) {
      if (w?.id && w.currency_id != null) walletToCurrency[w.id] = w.currency_id;
    }

    const currencyIds = Array.from(new Set(Object.values(walletToCurrency)));

    // 3) Fetch symbols for those currencies
    type Currency = { id: string | number; symbol: string | null };
    const { data: currencies, error: cErr } = await supabase
      .from("currencies")
      .select("id, symbol")
      .in("id", currencyIds);

    if (cErr) {
      return NextResponse.json({ ok: false, error: cErr.message }, { status: 500 });
    }

    const currencyToSymbol: Record<string | number, string> = {};
    for (const c of (currencies || []) as Currency[]) {
      if (c?.id != null && c?.symbol) currencyToSymbol[c.id] = c.symbol.toUpperCase();
    }

    // 4) Aggregate in JS by symbol
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

    // 5) Order & limit
    if (order === "usd") {
      rows.sort((a, b) => (b.usd_total || 0) - (a.usd_total || 0));
    } else {
      rows.sort((a, b) => (b.total || 0) - (a.total || 0));
    }
    rows = rows.slice(0, limit);

    // 6) Backward-compatible shape (adds usd_total; keeps old fields)
    return NextResponse.json({
      ok: true,
      order,
      sinceDays,
      total: rows.length,
      rows: rows.map(r => ({
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

