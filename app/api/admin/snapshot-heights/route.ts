// app/api/admin/snapshot-heights/route.ts
// Admin helper: pokreni heights ingest za SVE aktivne lance (po wallets ili ACTIVE_CHAINS)
// i vrati sažetak rezultata. Nema hardkodiranih simbola (npr. ADA).
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

// Dohvati aktivne lance (lowercase) iz ACTIVE_CHAINS ili iz wallets→currencies.
async function fetchActiveChains(supabase: any): Promise<string[]> {
  const override = (process.env.ACTIVE_CHAINS || "").trim();
  if (override) {
    return override.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  }
  const { data: wallets, error: wErr } = await supabase
    .from("wallets")
    .select("currency_id, active");
  if (wErr || !Array.isArray(wallets)) return [];

  const use = wallets.some((w: any) => w?.active === true)
    ? wallets.filter((w: any) => w?.active === true)
    : wallets;

  const ids = Array.from(new Set(use.map((w: any) => w?.currency_id).filter((x: any) => x != null)));
  if (ids.length === 0) return [];

  const { data: curr, error: cErr } = await supabase
    .from("currencies")
    .select("id, symbol")
    .in("id", ids);
  if (cErr || !Array.isArray(curr)) return [];

  return curr.map((c: any) => String(c.symbol || "").toLowerCase()).filter(Boolean);
}

async function hitIngest(chain: string) {
  // Gađamo produkcijski domain; ako želiš dinamički, možeš koristiti VERCEL_URL/NEXT_PUBLIC_BASE_URL.
  const url = `https://www.blockbattle.org/api/ingest/${chain}`;
  const secret = process.env.CRON_SECRET || "";
  const res = await fetch(url, {
    method: "POST",
    headers: { "x-cron-secret": secret },
    next: { revalidate: 0 },
    cache: "no-store",
  });

  let body: any = null;
  try { body = await res.json(); } catch { body = await res.text(); }

  return { chain: chain.toUpperCase(), status: res.status, body };
}

export async function POST(req: NextRequest) {
  try {
    // Jednostavna zaštita istim headerom kao CRON
    const expected = process.env.CRON_SECRET || "";
    const provided = req.headers.get("x-cron-secret") || "";
    if (!expected || provided !== expected) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();
    const chains = await fetchActiveChains(supabase); // npr. ['btc','eth','pol',...]
    if (chains.length === 0) {
      return NextResponse.json({ ok: false, error: "No active chains (wallets) found" }, { status: 400 });
    }

    const results: Array<{ chain: string; status: number; body: any }> = [];
    for (const c of chains) {
      // sekvencijalno da ne zagušimo RPC-eve
      // eslint-disable-next-line no-await-in-loop
      const r = await hitIngest(c);
      results.push(r);
    }

    const successCount = results.filter(r => r.status === 200 && r.body && r.body.ok === true).length;
    const errorCount = results.length - successCount;
    const total = results.length;

    return NextResponse.json({ ok: true, total, successCount, errorCount, results });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

// (Opcionalno) GET delegira na POST radi lakšeg testa iz browsera (i dalje traži x-cron-secret)
export async function GET(req: NextRequest) {
  return POST(req);
}

