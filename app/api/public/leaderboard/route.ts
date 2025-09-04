// app/api/public/leaderboard/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Always compute server-side
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Canonical chain aliasing so BSC/BNB/BINANCE -> BNB, POL/MATIC/POLYGON -> POL, etc.
const ALIAS_TO_CANON: Record<string, string> = {
  "btc": "BTC", "bitcoin": "BTC",
  "eth": "ETH", "ethereum": "ETH",
  "pol": "POL", "matic": "POL", "polygon": "POL",
  "bnb": "BNB", "bsc": "BNB", "binance": "BNB",
  "sol": "SOL", "solana": "SOL",
  "arb": "ARB", "arbitrum": "ARB",
  "op": "OP", "optimism": "OP",
  "avax": "AVAX", "avalanche": "AVAX",
  "atom": "ATOM", "cosmos": "ATOM",
  "dot": "DOT", "polkadot": "DOT",
  "ltc": "LTC", "litecoin": "LTC",
  "trx": "TRX", "tron": "TRX",
  "xlm": "XLM", "stellar": "XLM",
  "xrp": "XRP", "ripple": "XRP",
  "doge": "DOGE", "dogecoin": "DOGE",
};
const canon = (x?: string | null) =>
  ALIAS_TO_CANON[(x || "").toLowerCase()] || (x || "").toUpperCase();

// Supabase server client (prefers SERVICE_ROLE as in your old setup; falls back to ANON if needed)
function supa() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "";
  if (!url) throw new Error("Missing Supabase URL (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL)");

  // Keep old behavior (service role on server routes), but allow fallback to anon in dev
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  if (!key) throw new Error("Missing Supabase key (SUPABASE_SERVICE_ROLE_KEY / ANON)");

  return createClient(url, key, { auth: { persistSession: false } });
}

type Row = {
  amount: string | number | null;
  amount_usd: string | number | null;
  wallets?:
    | {
        chain?: string | null;
        currencies?: { symbol?: string | null } | null;
      }
    | Array<{
        chain?: string | null;
        currencies?: { symbol?: string | null } | null;
      }>
    | null;
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const order = (searchParams.get("order") || "native").toLowerCase(); // 'native' | 'usd'
    const limit = Math.max(50, Number(searchParams.get("scan") || "300")); // how many rows to scan/aggregate

    const supabase = supa();

    // Pull recent contributions with relations to currencies + chain (for fallback).
    // PostgREST nested selects behave like LEFT JOINs when relations are missing.
    const { data, error } = await supabase
      .from("contributions")
      .select(
        `
        amount,
        amount_usd,
        wallets:wallet_id (
          chain,
          currencies:currency_id (
            symbol
          )
        )
      `
      )
      .order("inserted_at", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const rows = (data || []) as Row[];

    // Aggregate by canonical chain
    type Agg = { chain: string; total: number; usd_total: number; contributions: number };
    const aggMap = new Map<string, Agg>();

    for (const r of rows) {
      const w: any = r.wallets;
      // Handle relation returned as object or array
      const wObj = Array.isArray(w) ? (w[0] ?? null) : w ?? null;

      const symbolFromCurrencies = wObj?.currencies?.symbol?.toUpperCase?.() || null;
      const chainFromWallet = wObj?.chain || null;
      const chain = canon(symbolFromCurrencies || chainFromWallet || "UNKNOWN");

      const amt = Number(r.amount ?? 0) || 0;
      const usd = Number(r.amount_usd ?? 0) || 0;

      const cur = aggMap.get(chain) || { chain, total: 0, usd_total: 0, contributions: 0 };
      cur.total += amt;
      cur.usd_total += usd;
      cur.contributions += 1;
      aggMap.set(chain, cur);
    }

    let list = Array.from(aggMap.values());

    // Sort
    if (order === "usd") {
      list.sort((a, b) => (b.usd_total - a.usd_total) || (b.contributions - a.contributions));
    } else {
      // default: native
      list.sort((a, b) => (b.total - a.total) || (b.usd_total - a.usd_total));
    }

    return NextResponse.json(
      {
        ok: true,
        order: order === "usd" ? "usd" : "native",
        total: list.length,
        rows: list,
      },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

