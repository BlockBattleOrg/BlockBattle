// app/api/public/leaderboard/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Always compute server-side
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Row = {
  amount: string | number | null;
  amount_usd: string | number | null;
  wallets?: {
    currencies?: {
      symbol?: string | null;
    } | null;
  } | null;
};

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const order = (searchParams.get("order") || "native").toLowerCase(); // 'native' | 'usd'
    const limit = Math.max(50, Number(searchParams.get("scan") || "300")); // koliko zapisa povući za agregaciju

    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!; // server-side key

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false },
    });

    // Dohvati recent kontribucije + relacije do currencies.symbol
    // Korištenje ugrađenih relacija PostgREST-a:
    // contributions → wallets (FK) → currencies (FK)
    const { data, error } = await supabase
      .from("contributions")
      .select(
        `
        amount,
        amount_usd,
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

    const rows = (data || []) as Row[];

    // Agregacija po chainu
    type Agg = { chain: string; total: number; usd_total: number; contributions: number };
    const aggMap = new Map<string, Agg>();

    for (const r of rows) {
      const chain =
        r?.wallets?.currencies?.symbol?.toUpperCase() ||
        "UNKNOWN";

      const amt = Number(r.amount ?? 0) || 0;
      const usd = Number(r.amount_usd ?? 0) || 0;

      const cur = aggMap.get(chain) || { chain, total: 0, usd_total: 0, contributions: 0 };
      cur.total += amt;
      cur.usd_total += usd;
      cur.contributions += 1;
      aggMap.set(chain, cur);
    }

    let list = Array.from(aggMap.values());

    // Poredak
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

