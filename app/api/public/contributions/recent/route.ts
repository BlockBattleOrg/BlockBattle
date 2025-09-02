// app/api/public/contributions/recent/route.ts
// Robust "recent contributions" endpoint.
// - Uses relational select contributions → wallets → currencies to resolve chain symbol
// - LEFT-like semantics via PostgREST nested selects (no hard-coded chains)
// - Returns consistent shape used by the frontend:
//   { ok, total, rows: [{ chain, amount, amount_usd, tx, timestamp }] }

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RecentRow = {
  amount: string | number | null;
  amount_usd: string | number | null;
  tx_hash: string | null;
  block_time: string | null;     // timestamptz
  inserted_at: string | null;    // timestamptz
  wallets?: {
    currencies?: {
      symbol?: string | null;
    } | null;
  } | null;
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const limitRaw = Number(searchParams.get("limit") || "10");
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 10;

    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; // server-side key

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });

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

    const rows = (data || []) as RecentRow[];

    const mapped = rows.map((r) => {
      const chain =
        r?.wallets?.currencies?.symbol?.toUpperCase() || "UNKNOWN";

      // Prefer on-chain block_time; fallback to inserted_at.
      const ts = r.block_time || r.inserted_at || null;

      return {
        chain,
        amount: toNum(r.amount),
        amount_usd: toNum(r.amount_usd),
        tx: r.tx_hash || null,
        timestamp: ts, // keep as ISO string (frontend already expects "timestamp")
      };
    });

    return NextResponse.json(
      { ok: true, total: mapped.length, rows: mapped },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}

function toNum(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

