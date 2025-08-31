// app/api/public/overview/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  if (!url || !key) throw new Error("Missing Supabase env vars");
  return createClient(url, key, { auth: { persistSession: false } });
}

// Pragovi (u satima)
const FRESH_OK_HOURS = parseInt(process.env.OVERVIEW_FRESH_OK_HOURS || "6", 10);     // zeleno
const FRESH_STALE_HOURS = parseInt(process.env.OVERVIEW_FRESH_STALE_HOURS || "24", 10); // žuto do 24h

type HeightRow = { chain: string; height: number | null; updated_at?: string | null };

async function fetchActiveSymbols(supabase: ReturnType<typeof createClient>): Promise<Set<string>> {
  const override = (process.env.ACTIVE_CHAINS || "").trim();
  if (override) {
    return new Set(
      override.split(",").map(s => s.trim().toUpperCase()).filter(Boolean)
    );
  }

  // pokušaj koristiti wallets.active = true; ako kolona ne postoji, uzmi sve iz wallets
  const { data: wallets, error: wErr } = await supabase
    .from("wallets")
    .select("currency_id, active");
  if (wErr || !Array.isArray(wallets)) return new Set();

  // ako postoji i ima true zapisa, filtriraj po active; inače uzmi sve
  const use = wallets.some((w: any) => w?.active === true)
    ? wallets.filter((w: any) => w?.active === true)
    : wallets;

  const ids = Array.from(new Set(use.map((w: any) => w?.currency_id).filter((x: any) => x != null)));

  if (ids.length === 0) return new Set();

  const { data: curr, error: cErr } = await supabase
    .from("currencies")
    .select("id, symbol")
    .in("id", ids);

  if (cErr || !Array.isArray(curr)) return new Set();
  return new Set(curr.map((c: any) => String(c.symbol || "").toUpperCase()).filter(Boolean));
}

export async function GET(_req: NextRequest) {
  try {
    const supabase = getSupabase();

    // 1) allow-list iz wallets (ili ACTIVE_CHAINS override)
    const allowed = await fetchActiveSymbols(supabase);

    // 2) povuci heights (posljednji zapisi po chainu)
    const { data, error } = await supabase
      .from("heights_daily")
      .select("chain, height, updated_at")
      .order("chain", { ascending: true })
      .limit(1000);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const now = Date.now();

    // 3) zadrži samo chainove koji su u wallets/allowed
    const filtered = (data || [])
      .map((r: any) => ({
        chain: String(r.chain || "").toUpperCase(),
        height: (r as HeightRow).height ?? null,
        ts: r?.updated_at ? Date.parse(r.updated_at) : undefined,
      }))
      .filter(r => allowed.size === 0 ? true : allowed.has(r.chain))
      // pick latest per chain by timestamp
      .reduce<Record<string, { height: number | null; ts?: number }>>((acc, r) => {
        const prev = acc[r.chain];
        if (!prev || ((r.ts ?? 0) > (prev.ts ?? 0))) acc[r.chain] = { height: r.height, ts: r.ts };
        return acc;
      }, {});

    const rows = Object.entries(filtered).map(([chain, v]) => {
      let status: "ok" | "stale" | "issue" = "ok";
      let ageHours: number | null = null;

      if (typeof v.ts === "number") {
        const ageMs = now - v.ts;
        ageHours = Math.max(0, ageMs / 36e5);
        if (ageHours > FRESH_STALE_HOURS) status = "issue";
        else if (ageHours > FRESH_OK_HOURS) status = "stale";
        else status = "ok";
      } else {
        // ako nemamo timestamp, budi tolerantan i prikaži ok
        status = "ok";
      }

      return { chain, height: v.height, status, ageHours };
    });

    const counts = {
      ok: rows.filter(r => r.status === "ok").length,
      stale: rows.filter(r => r.status === "stale").length,
      issue: rows.filter(r => r.status === "issue").length,
    };

    return NextResponse.json({
      ok: true,
      total: rows.length,
      ...counts,
      rows,
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

