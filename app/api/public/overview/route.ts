// app/api/public/overview/route.ts
// Heights overview with per-chain freshness flag (ok=true if last update < 6h).
// Tolerant to schema differences: tries heights_daily.day/created_at, falls back to OK.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  if (!url || !key) {
    throw new Error("Missing Supabase env: need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY).");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

type Row = { chain: string; height: number | null };
type Resp = { ok: boolean; total: number; updated: number; rows: Row[] };

const FRESH_HOURS = parseInt(process.env.OVERVIEW_FRESH_HOURS || "6", 10);

export async function GET(_req: NextRequest) {
  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("heights_daily")
      .select("chain, height, day, created_at")
      .order("chain", { ascending: true })
      .limit(500);
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    const now = Date.now();
    const freshMs = FRESH_HOURS * 60 * 60 * 1000;

    // group by chain → pick latest entry by (day || created_at)
    const byChain: Record<string, { height: number | null; ts?: number }> = {};
    for (const r of (data || []) as any[]) {
      const chain = String(r.chain || "").toUpperCase();
      const tsStr = r.day ?? r.created_at ?? null;
      const tsNum = tsStr ? Date.parse(tsStr) : undefined;
      const prev = byChain[chain];
      if (!prev) byChain[chain] = { height: r.height ?? null, ts: tsNum };
      else {
        const older = prev.ts ?? 0;
        const newer = tsNum ?? 0;
        if (newer >= older) byChain[chain] = { height: r.height ?? prev.height ?? null, ts: newer || older };
      }
    }

    const rows = Object.entries(byChain).map(([chain, v]) => {
      const ok = typeof v.ts === "number" ? (now - v.ts) < freshMs : true; // tolerant fallback
      return { chain, height: v.height ?? null, ok };
    });

    return NextResponse.json({
      ok: true,
      total: rows.length,
      updated: rows.filter(r => r.ok).length,
      rows,
    } satisfies Resp);
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

