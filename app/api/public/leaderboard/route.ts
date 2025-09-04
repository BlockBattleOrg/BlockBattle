// app/api/public/contributions/leaderboard/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

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
const canon = (x?: string | null) => ALIAS_TO_CANON[(x || "").toLowerCase()] || (x || "").toUpperCase();

function need(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ENV: ${name}`);
  return v;
}
function supa() {
  return createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false },
  });
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const order = (url.searchParams.get("order") || "usd").toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || "50")));

    const client = supa();
    const { data, error } = await client
      .from("contributions")
      .select("amount, amount_usd, wallets!inner(chain)")
      .order("block_time", { ascending: false })
      .limit(5000); // safety cap

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const agg: Record<string, { total: number; usd_total: number; contributions: number }> = {};
    for (const r of data || []) {
      const chain = canon(r?.wallets?.chain);
      if (!chain) continue;
      const amt = Number(r.amount);
      const usd = r.amount_usd === null ? 0 : Number(r.amount_usd);
      if (!agg[chain]) agg[chain] = { total: 0, usd_total: 0, contributions: 0 };
      agg[chain].total += amt;
      agg[chain].usd_total += usd;
      agg[chain].contributions += 1;
    }

    let rows = Object.entries(agg).map(([chain, v]) => ({ chain, ...v }));
    if (order === "usd") {
      rows = rows.sort((a, b) => b.usd_total - a.usd_total);
    } else if (order === "native") {
      rows = rows.sort((a, b) => b.total - a.total);
    }

    rows = rows.slice(0, limit);

    return NextResponse.json({ ok: true, order, total: rows.length, rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

