// app/api/public/overview/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  if (!url || !key) {
    throw new Error("Missing Supabase env vars");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

const FRESH_HOURS = parseInt(process.env.OVERVIEW_FRESH_HOURS || "6", 10);

export async function GET(_req: NextRequest) {
  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from("heights_daily")
      .select("chain, height, updated_at")
      .order("chain", { ascending: true })
      .limit(500);

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

    const now = Date.now();
    const freshMs = FRESH_HOURS * 60 * 60 * 1000;

    const byChain: Record<string, { height: number | null; ts?: number }> = {};
    for (const r of data || []) {
      const chain = String(r.chain || "").toUpperCase();
      const ts = r.updated_at ? Date.parse(r.updated_at as any) : undefined;
      const prev = byChain[chain];
      if (!prev || ((ts ?? 0) > (prev.ts ?? 0))) {
        byChain[chain] = { height: r.height ?? null, ts };
      }
    }

    const rows = Object.entries(byChain).map(([chain, v]) => {
      const ok = typeof v.ts === "number" ? now - v.ts < freshMs : true;
      return { chain, height: v.height, ok };
    });

    return NextResponse.json({
      ok: true,
      total: rows.length,
      updated: rows.filter(r => r.ok).length,
      rows,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

