// app/api/admin/fx-sync/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchUsdPrices, loadCurrencyMeta, toUsd } from "@/lib/fx";

const CRON_SECRET = process.env.CRON_SECRET || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// How many rows to update per invocation
const BATCH_SIZE = parseInt(process.env.FX_SYNC_BATCH_SIZE || "100", 10);

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const hdr = req.headers.get("x-cron-secret") || "";
  if (!CRON_SECRET || hdr !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 1) Pull a batch of contributions without USD
  const { data: rows, error } = await supabase
    .from("contributions")
    .select("id, symbol, amount_native")
    .is("amount_usd", null)
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, message: "Nothing to do" });
  }

  const symbols = Array.from(new Set(rows.map((r) => r.symbol?.toUpperCase()).filter(Boolean))) as string[];

  // 2) Load decimals per symbol
  const meta = await loadCurrencyMeta(supabase, symbols);

  // 3) Fetch prices
  const prices = await fetchUsdPrices(symbols);

  // 4) Compute USD values and build updates
  type UpdateRow = { id: number; amount_usd: number };
  const updates: UpdateRow[] = [];
  for (const r of rows) {
    const sym = r.symbol?.toUpperCase();
    if (!sym) continue;
    const decimals = meta[sym]?.decimals ?? 18;
    const usd = toUsd(sym, String(r.amount_native ?? "0"), decimals, prices);
    if (usd !== null && isFinite(usd)) {
      updates.push({ id: r.id, amount_usd: usd });
    }
  }

  // 5) Upsert via RPC (faster in batch) or fallback to per-row updates
  let updated = 0;
  if (updates.length > 0) {
    // Break into chunks of 100 for safety
    const chunkSize = 100;
    for (let i = 0; i < updates.length; i += chunkSize) {
      const chunk = updates.slice(i, i + chunkSize);
      const { error: upErr } = await supabase
        .from("contributions")
        .upsert(chunk, { onConflict: "id", ignoreDuplicates: false })
        .select("id");
      if (upErr) {
        return NextResponse.json({ ok: false, error: upErr.message }, { status: 500 });
      }
      updated += chunk.length;
    }
  }

  return NextResponse.json({
    ok: true,
    scanned: rows.length,
    updated,
    symbols,
    prices,
  });
}

