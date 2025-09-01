// app/api/public/blocks/recent/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs"; // use Node runtime (service role key, stable crypto)

type RawRow = {
  id: string | number;
  chain?: string | null;
  symbol?: string | null;
  currency_id?: string | number | null;
  amount_usd?: number | null;
  amount?: number | null; // fallback, if USD missing
  timestamp?: string | null;
  ts?: string | null;
  tx_hash?: string | null;
};

type BlockRow = {
  id: string;
  chain: string;        // canonical lower-case (e.g., 'eth', 'bsc', 'pol')
  amount_usd: number;   // >= 0
  ts: string;           // ISO timestamp
  tx_hash: string | null;
};

function normalizeChain(input?: string | null, symbol?: string | null, currencyId?: string | number | null): string {
  // Priority: explicit chain -> symbol -> currency_id
  const v = (input ?? symbol ?? String(currencyId ?? "")).toString().trim().toLowerCase();
  if (!v) return "unknown";
  // Common aliases
  if (v === "matic" || v === "pol" || v === "polygon") return "pol";
  if (v === "bsc" || v === "bnb" || v === "binance-smart-chain" || v === "binance") return "bsc";
  if (v === "eth" || v === "ethereum") return "eth";
  if (v === "arb" || v === "arbitrum") return "arb";
  if (v === "op" || v === "optimism") return "op";
  if (v === "avax" || v === "avalanche") return "avax";
  if (v === "xrp" || v === "ripple") return "xrp";
  if (v === "xlm" || v === "stellar") return "xlm";
  if (v === "trx" || v === "tron") return "trx";
  if (v === "dot" || v === "polkadot") return "dot";
  if (v === "atom" || v === "cosmos") return "atom";
  if (v === "btc" || v === "bitcoin") return "btc";
  if (v === "ltc" || v === "litecoin") return "ltc";
  if (v === "doge" || v === "dogecoin") return "doge";
  if (v === "sol" || v === "solana") return "sol";
  return v;
}

function normalizeTs(input?: string | null, fallback?: string | null): string {
  const raw = input ?? fallback ?? new Date().toISOString();
  // Ensure valid ISO string
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function toBlockRow(r: RawRow): BlockRow {
  return {
    id: String(r.id),
    chain: normalizeChain(r.chain, r.symbol, r.currency_id),
    amount_usd: typeof r.amount_usd === "number" ? r.amount_usd : Math.max(0, Number(r.amount ?? 0)),
    ts: normalizeTs(r.timestamp, r.ts),
    tx_hash: r.tx_hash ?? null,
  };
}

function parseLimit(searchParams: URLSearchParams, def = 200, max = 500): number {
  const v = Number(searchParams.get("limit") ?? def);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(Math.trunc(v), max);
}

function parseChains(searchParams: URLSearchParams): string[] | null {
  const chain = searchParams.get("chain"); // e.g. "eth" or "eth,bsc"
  if (!chain) return null;
  return chain
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = parseLimit(url.searchParams, 200, 500);
    const chains = parseChains(url.searchParams); // optional filter

    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { ok: false, error: "Supabase env missing (URL or SERVICE_ROLE_KEY)" },
        { status: 500 }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // Select a superset of fields (defensive) and normalize in app layer.
    // Order by newest contribution timestamp (use 'timestamp' if present; otherwise 'ts' or 'id' fallback)
    // Note: If your schema uses different column names, adapt them here.
    let query = supabase
      .from("contributions")
      .select("id, chain, symbol, currency_id, amount_usd, amount, timestamp, ts, tx_hash")
      .order("timestamp", { ascending: false, nullsFirst: false });

    // If 'timestamp' is missing in some rows, fallback secondary order to 'ts' then 'id'
    // Supabase doesn't support multi-column order in a single call nicely across nulls,
    // but results will be "newest-first" enough for recent data. Optionally you can re-sort in app code.

    // Apply chain filter if provided
    if (chains && chains.length > 0) {
      // We'll filter after fetch to leverage normalizeChain() across aliases
      // (e.g. 'bsc' and 'bnb' should be treated the same).
      // To keep bandwidth sane, keep the SQL limit reasonable (e.g., 1000) and then slice on app side.
      query = query.limit(Math.min(limit * 3, 1000)); // overfetch x3 if filtering client-side
      const { data, error } = await query;
      if (error) {
        return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      }
      const rows = (data ?? []).map(toBlockRow).filter((r) => chains.includes(r.chain)).slice(0, limit);
      return NextResponse.json({ ok: true, rows, count: rows.length }, { status: 200 });
    }

    // No chain filter: fetch exactly 'limit'
    query = query.limit(limit);
    const { data, error } = await query;
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const rows = (data ?? []).map(toBlockRow);
    return NextResponse.json({ ok: true, rows, count: rows.length }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}

