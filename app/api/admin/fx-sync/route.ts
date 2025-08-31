// app/api/admin/fx-sync/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchUsdPrices } from "@/lib/fx";

export const runtime = "nodejs";        // forsiraj Node runtime (ne Edge)
export const dynamic = "force-dynamic"; // admin endpoint

const CRON_SECRET = process.env.CRON_SECRET || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BATCH_SIZE = parseInt(process.env.FX_SYNC_BATCH_SIZE || "100", 10);

type ContribRow = {
  id: number;
  wallet_id: string;
  amount: number | null;
};

type WalletRow = {
  id: string;
  symbol: string | null;
};

export async function POST(req: NextRequest) {
  const hdr = req.headers.get("x-cron-secret") || "";
  if (!CRON_SECRET || hdr !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 1) Uzmemo batch contributions gdje je amount_usd NULL
  const { data: contribs, error: cErr } = await supabase
    .from("contributions")
    .select("id, wallet_id, amount")
    .is("amount_usd", null)
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);

  if (cErr) {
    return NextResponse.json({ ok: false, error: cErr.message }, { status: 500 });
  }
  if (!contribs || contribs.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, message: "Nothing to do" });
  }

  // 2) Dohvati sve pripadne wallete i njihove simbole
  const walletIds = Array.from(new Set(contribs.map((r) => r.wallet_id).filter(Boolean))) as string[];
  const { data: wallets, error: wErr } = await supabase
    .from("wallets")
    .select("id, symbol")
    .in("id", walletIds);

  if (wErr) {
    return NextResponse.json({ ok: false, error: wErr.message }, { status: 500 });
  }

  const walletSymbol: Record<string, string> = {};
  for (const w of (wallets || []) as WalletRow[]) {
    if (w?.id && w?.symbol) walletSymbol[w.id] = w.symbol.toUpperCase();
  }

  // 3) Skupi unikatne simbole iz batcha i povuci njihove USD cijene
  const symbols = Array.from(
    new Set(
      contribs
        .map((r) => walletSymbol[r.wallet_id])
        .filter((s): s is string => typeof s === "string" && s.length > 0)
    )
  );
  const prices = await fetchUsdPrices(symbols); // npr. { ETH: 2xxx.xx, POL: 0.xx, ... }

  // 4) Izračunaj amount_usd = amount * price i pripremi upserte
  const updates: { id: number; amount_usd: number }[] = [];
  for (const r of contribs as ContribRow[]) {
    const sym = walletSymbol[r.wallet_id];
    if (!sym) continue;
    const p = prices[sym];
    if (!p || r.amount == null || !isFinite(r.amount)) continue;
    const usd = r.amount * p;
    if (isFinite(usd)) {
      updates.push({ id: r.id, amount_usd: usd });
    }
  }

  // 5) Upsert u manjim chunkovima
  let updated = 0;
  if (updates.length > 0) {
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
    scanned: contribs.length,
    updated,
    symbols,
  });
}

