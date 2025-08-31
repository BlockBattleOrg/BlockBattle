// app/api/admin/fx-sync/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchUsdPrices } from "@/lib/fx";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CRON_SECRET = process.env.CRON_SECRET || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const BATCH_SIZE = parseInt(process.env.FX_SYNC_BATCH_SIZE || "100", 10);

type ContribRow = { id: number; wallet_id: string; amount: number | null };
type WalletRow = { id: string; currency_id: string | number | null };
type CurrencyRow = { id: string | number; symbol: string | null };

export async function POST(req: NextRequest) {
  const hdr = req.headers.get("x-cron-secret") || "";
  if (!CRON_SECRET || hdr !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // 1) Batch contributions bez USD
  const { data: contribs, error: cErr } = await supabase
    .from("contributions")
    .select("id, wallet_id, amount")
    .is("amount_usd", null)
    .order("id", { ascending: true })
    .limit(BATCH_SIZE);

  if (cErr) return NextResponse.json({ ok: false, error: cErr.message }, { status: 500 });
  if (!contribs || contribs.length === 0) {
    return NextResponse.json({ ok: true, updated: 0, message: "Nothing to do" });
  }

  // 2) wallets -> currency_id
  const walletIds = Array.from(new Set(contribs.map(r => r.wallet_id).filter(Boolean))) as string[];
  const { data: wallets, error: wErr } = await supabase
    .from("wallets")
    .select("id, currency_id")
    .in("id", walletIds);
  if (wErr) return NextResponse.json({ ok: false, error: wErr.message }, { status: 500 });

  const walletCurrency: Record<string, string | number> = {};
  for (const w of (wallets || []) as WalletRow[]) {
    if (w?.id && w?.currency_id != null) walletCurrency[w.id] = w.currency_id;
  }

  // 3) currencies -> symbol
  const currencyIds = Array.from(new Set(Object.values(walletCurrency)));
  const { data: currencies, error: curErr } = await supabase
    .from("currencies")
    .select("id, symbol")
    .in("id", currencyIds);
  if (curErr) return NextResponse.json({ ok: false, error: curErr.message }, { status: 500 });

  const currencySymbol: Record<string | number, string> = {};
  for (const c of (currencies || []) as CurrencyRow[]) {
    if (c?.id != null && c?.symbol) currencySymbol[c.id] = c.symbol.toUpperCase();
  }

  // 4) cijene
  const symbols = Array.from(
    new Set(contribs.map(r => currencySymbol[walletCurrency[r.wallet_id]]).filter((s): s is string => !!s))
  );
  const prices = await fetchUsdPrices(symbols);

  // 5) izračun
  const updates: { id: number; amount_usd: number; priced_at: string }[] = [];
  for (const r of contribs as ContribRow[]) {
    const sym = currencySymbol[walletCurrency[r.wallet_id]];
    const p = prices[sym as keyof typeof prices];
    if (!sym || !p || r.amount == null || !isFinite(r.amount)) continue;
    const usd = r.amount * p;
    if (isFinite(usd)) updates.push({ id: r.id, amount_usd: usd, priced_at: new Date().toISOString() });
  }

  // 6) siguran UPDATE po ID-u (nema upserta)
  let updated = 0;
  for (const u of updates) {
    const { error: updErr } = await supabase
      .from("contributions")
      .update({ amount_usd: u.amount_usd, priced_at: u.priced_at })
      .eq("id", u.id);
    if (updErr) {
      return NextResponse.json({ ok: false, error: updErr.message, failed_id: u.id }, { status: 500 });
    }
    updated++;
  }

  return NextResponse.json({ ok: true, scanned: contribs.length, updated, symbols });
}

