// app/api/public/contributions/recent/route.ts
// Recent contributions: last N rows with { chain, amount, amount_usd, tx, timestamp }.
// If amount_usd is NULL, we compute USD on-the-fly using lib/fx.ts (real-time display).
// No schema changes.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchUsdPrices, loadCurrencyMeta, toUsd } from "@/lib/fx";

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

type ContribRow = {
  id: number;
  wallet_id: string;
  amount: number | null;
  amount_usd: number | null;
  tx_hash: string | null;
  timestamp?: string | null; // if exists in schema
};
type WalletRow = { id: string; currency_id: string | number | null };
type CurrencyRow = { id: string | number; symbol: string | null; decimals?: number | null };

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limitParam = parseInt(url.searchParams.get("limit") || "10", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 10;

    const supabase = getSupabase();

    // 1) last N by id desc (try selecting timestamp if present)
    let rows: ContribRow[] = [];
    {
      const { data, error } = await supabase
        .from("contributions")
        .select("id, wallet_id, amount, amount_usd, tx_hash, timestamp")
        .order("id", { ascending: false })
        .limit(limit);

      if (!error && data) {
        rows = data as ContribRow[];
      } else {
        const { data: data2, error: err2 } = await supabase
          .from("contributions")
          .select("id, wallet_id, amount, amount_usd, tx_hash")
          .order("id", { ascending: false })
          .limit(limit);
        if (err2) return NextResponse.json({ ok: false, error: err2.message }, { status: 500 });
        rows = (data2 || []) as ContribRow[];
      }
    }

    if (!rows.length) return NextResponse.json({ ok: true, total: 0, rows: [] });

    // 2) wallet -> currency
    const walletIds = Array.from(new Set(rows.map(r => r.wallet_id).filter(Boolean))) as string[];
    const { data: wallets, error: wErr } = await supabase
      .from("wallets")
      .select("id, currency_id")
      .in("id", walletIds);
    if (wErr) return NextResponse.json({ ok: false, error: wErr.message }, { status: 500 });

    const walletToCurrency: Record<string, string | number> = {};
    for (const w of (wallets || []) as WalletRow[]) {
      if (w?.id && w.currency_id != null) walletToCurrency[w.id] = w.currency_id;
    }
    const currencyIds = Array.from(new Set(Object.values(walletToCurrency)));

    // 3) currency -> symbol, decimals
    const { data: currencies, error: cErr } = await supabase
      .from("currencies")
      .select("id, symbol, decimals")
      .in("id", currencyIds);
    if (cErr) return NextResponse.json({ ok: false, error: cErr.message }, { status: 500 });

    const currencyToSymbol: Record<string | number, string> = {};
    const currencyMeta: Record<string | number, { decimals: number }> = {};
    for (const c of (currencies || []) as CurrencyRow[]) {
      if (c?.id != null && c?.symbol) {
        currencyToSymbol[c.id] = c.symbol.toUpperCase();
        currencyMeta[c.id] = { decimals: c.decimals ?? 18 };
      }
    }

    // 4) compute USD for those missing using live prices
    const neededSymbols = Array.from(
      new Set(
        rows
          .filter(r => (r.amount_usd == null) && r.amount != null)
          .map(r => currencyToSymbol[walletToCurrency[r.wallet_id]])
          .filter(Boolean) as string[]
      )
    );

    let prices: Record<string, number> = {};
    if (neededSymbols.length > 0) {
      // we have chain symbols already (from currencies), so go straight to price fetch
      prices = await fetchUsdPrices(neededSymbols);
    }

    const result = rows.map((r) => {
      const curId = walletToCurrency[r.wallet_id];
      const symbol = currencyToSymbol[curId] || null;
      let usd = r.amount_usd;

      if (usd == null && typeof r.amount === "number" && symbol) {
        const meta = currencyMeta[curId];
        if (meta) {
          const calc = toUsd(symbol, String(r.amount), meta.decimals, prices);
          if (typeof calc === "number" && isFinite(calc)) usd = calc;
        }
      }

      return {
        chain: symbol,
        amount: r.amount ?? null,
        amount_usd: usd ?? null,
        tx: r.tx_hash ?? null,
        timestamp: r.timestamp ?? null,
      };
    });

    return NextResponse.json({ ok: true, total: result.length, rows: result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

