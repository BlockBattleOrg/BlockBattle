// app/api/public/contributions/leaderboard/route.ts
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

    // Uzmi sve potrebne atribute u jednom upitu
    const { data, error } = await sb
      .from("contributions")
      .select(
        `
        amount,
        wallet:wallets (
          id, chain, is_active,
          currencies ( symbol )
        )
      `
      );

    if (error) throw error;

    const map = new Map<string, { total: number; contributions: number }>();

    for (const r of (data || [])) {
      const w = (r as any).wallet;
      if (!w || w.is_active === false) continue;

      const label = toTicker(w?.currencies?.symbol, w?.chain);
      if (!label) continue;

      const entry = map.get(label) || { total: 0, contributions: 0 };
      entry.total += Number((r as any).amount || 0);
      entry.contributions += 1;
      map.set(label, entry);
    }

    const rows = Array.from(map.entries())
      .map(([chain, v]) => ({ chain, total: v.total, contributions: v.contributions }))
      .sort((a, b) => b.total - a.total);

    return NextResponse.json({ ok: true, rows });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Leaderboard API error" }, { status: 500 });
  }
}

