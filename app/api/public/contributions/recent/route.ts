// app/api/public/contributions/recent/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function toTicker(symbol?: string | null, chain?: string | null) {
  const s = String(symbol || chain || "").trim().toUpperCase();
  if (!s) return "";
  if (s === "MATIC" || s === "POLYGON") return "POL";
  return s;
}

export async function GET() {
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
    }
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data, error } = await sb
      .from("contributions")
      .select(
        `
        tx_hash, amount, block_time,
        wallet:wallets (
          id, chain, is_active,
          currencies ( symbol )
        )
      `
      )
      .order("block_time", { ascending: false })
      .limit(20);

    if (error) throw error;

    const rows = [];
    for (const r of data || []) {
      const w = (r as any).wallet;
      if (!w || w.is_active === false) continue;

      const chain = toTicker(w?.currencies?.symbol, w?.chain);
      if (!chain) continue;

      rows.push({
        chain,
        amount: Number((r as any).amount || 0),
        tx: String((r as any).tx_hash || ""),
        timestamp: (r as any).block_time,
      });
    }

    return NextResponse.json({ ok: true, rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Recent API error" }, { status: 500 });
  }
}

