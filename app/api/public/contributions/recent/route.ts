// app/api/public/contributions/recent/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

// Alias map for canonical chain names
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

// Supabase client helper with fallback to non-next-public vars
function supa() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    "";
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "";
  if (!url || !anon) throw new Error("Missing Supabase ENV vars");
  return createClient(url, anon, { auth: { persistSession: false } });
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || "10")));

    const client = supa();
    const { data, error } = await client
      .from("contributions")
      .select("id, tx_hash, amount, amount_usd, block_time, wallets!inner(chain,address)")
      .order("block_time", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const rows = (data || []).map((r: any) => {
      const w: any = r.wallets;
      const rawChain = Array.isArray(w) ? w[0]?.chain : w?.chain;
      return {
        chain: canon(rawChain),
        amount: Number(r.amount),
        amount_usd: r.amount_usd === null ? null : Number(r.amount_usd),
        tx: r.tx_hash as string,
        timestamp: r.block_time as string,
      };
    });

    return NextResponse.json({ ok: true, total: rows.length, rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

