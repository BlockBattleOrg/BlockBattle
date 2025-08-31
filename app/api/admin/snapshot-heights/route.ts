// app/api/admin/snapshoot-heights/route.ts
// Admin helper: pokreni heights ingest za SVE aktivne lance (po wallets ili ACTIVE_CHAINS)
// i vrati sažetak rezultata. Nema hardkodirane ADA.
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

async function fetchActiveSymbols(supabase: any): Promise<string[]> {
  const override = (process.env.ACTIVE_CHAINS || "").trim();
  if (override) {
    return override.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  }
  const { data: wallets, error: wErr } = await supabase.from("wallets").select("currency_id, active");
  if (wErr || !Array.isArray(wallets)) return [];
  const use = wallets.some((w: any) => w?.active === true)
    ? wallets.filter((w: any) => w?.active === true)
    : wallets;
  const ids = Array.from(new Set(use.map((w: any) => w?.currency_id).filter((x: any) => x != null)));
  if (ids.length === 0) return [];
  const { data: curr, error: cErr } = await supabase.from("currencies").select("id, symbol").in("id", ids);
  if (cErr || !Array.isArray(curr)) return [];
  return curr.map((c: any) => String(c.symbol || "").toLowerCase()).filter(Boolean);
}

async function hitIngest(chain: string) {
  const base = process.env.NEXT_PUBLIC_BASE_URL || process.env.BASE_URL || "";
  const origin = base || process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "";
  const host = origin || ""; // ako nema, koristi apsolutni URL ispod

  const url = host
    ? `${host}/api/ingest/${chain}`
    : `https://www.blockbattle.org/api/ingest/${chain}`;

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
    // Opcionalna zaštita istim headerom kao cron
    const secret = req.headers.get("x-cron-secret");
    const expected = process.env.CRON_SECRET || "";
    if (!expected || secret !== expected) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const supabase = getSupabase();
    const chains = await fetchActiveSymbols(supabase); // npr. ['btc','eth','pol',...]
    if (chains.length === 0) {
      return NextResponse.json({ ok: false, error: "No active chains (wallets) found" }, { status: 400 });
    }

    const results: any[] = [];
    // sekvencijalno (ako želiš paralelno: Promise.allSettled)
    for (const c of chains) {
      // mala pauza da ne “zaburstamo” endpoint-e
      // eslint-disable-next-line no-await-in-loop
      const r = await hitIngest(c);
      results.push(r);
    }

    const summary = {
      ok: results.filter(r => r.status === 200 && (r.body?.ok === true)).length,
      total: results.length,
      errors: results.filter(r => !(r.status === 200 && (r.body?.ok === true))).length,
    };

    return NextResponse.json({ ok: true, ...summary, results });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

// (Po želji) GET delegira na POST radi lakšeg testa iz browsera
export async function GET(req: NextRequest) {
  return POST(req);
}

