// app/api/public/contributions/recent/route.ts
// Robust "recent contributions" endpoint.
//
// - Uses relational select contributions → wallets → currencies to resolve chain symbol
// - LEFT-like semantics via PostgREST nested selects (no hard-coded chains)
// - Returns consistent shape used by the frontend:
//   { ok, total, rows: [{ chain, amount, amount_usd, tx, timestamp }] }

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

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

type RecentRow = {
  amount: string | number | null;
  amount_usd: string | number | null;
  tx_hash: string | null;
  block_time: string | null;     // timestamptz
  inserted_at: string | null;    // timestamptz
  wallets?: {
    chain?: string | null;
    currencies?: {
      symbol?: string | null;
    } | null;
  } | Array<{
    chain?: string | null;
    currencies?: { symbol?: string | null } | null;
  }> | null;
};

/** Supabase server client
 *  - Prefer SERVICE_ROLE on server routes (old working setup),
 *  - Fallback to ANON when SERVICE_ROLE is not present (e.g. local/dev).
 */
function supa() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "";
  if (!url) throw new Error("Missing Supabase URL (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL)");

  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "";

  const key = serviceRole || anon;
  if (!key) throw new Error("Missing Supabase key (SUPABASE_SERVICE_ROLE_KEY / ANON)");

  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limitRaw = Number(searchParams.get("limit") || "10");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 10;

    const supabase = supa();

    // Pull most recent contributions with relational symbols.
    // NOTE: Nested selects in PostgREST behave like LEFT JOINs for missing relations.
    const { data, error } = await supabase
      .from("contributions")
      .select(
        `
        amount,
        amount_usd,
        tx_hash,
        block_time,
        inserted_at,
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

    const rows = (data || []).map((r: RecentRow) => {
      // Handle relation returned as object or array
      const w: any = r.wallets;
      const wObj = Array.isArray(w) ? (w[0] ?? null) : w ?? null;
      const symbol = wObj?.currencies?.symbol ?? null;
      const chainRaw = symbol || wObj?.chain || null;
      return {
        chain: canon(chainRaw),
        amount: r.amount === null ? 0 : Number(r.amount),
        amount_usd: r.amount_usd === null ? null : Number(r.amount_usd),
        tx: r.tx_hash || "",
        timestamp: r.block_time || r.inserted_at || "",
      };
    });

    return NextResponse.json({ ok: true, total: rows.length, rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

