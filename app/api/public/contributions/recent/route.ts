// app/api/public/contributions/recent/route.ts
// Recent contributions: last N rows with { chain, amount, amount_usd, tx, timestamp }.
// - Uses legacy env resolution (SERVICE_ROLE preferred, ANON fallback).
// - Paginira po ID-ju (bez ovisnosti o created_at).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
  if (!url || !key) {
    throw new Error(
      "Missing Supabase env: need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)."
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

type ContribRow = {
  id: number;
  wallet_id: string;
  amount: number | null;
  amount_usd: number | null;
  tx_hash: string | null;
  timestamp?: string | null; // ako postoji u shemi
};
type WalletRow = { id: string; currency_id: string | number | null };
type CurrencyRow = { id: string | number; symbol: string | null };

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limitParam = parseInt(url.searchParams.get("limit") || "10", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 10;

    const supabase = getSupabase();

    // 1) Zadnjih N po ID desc, pokušaj s `timestamp` kolonom, padni na varijantu bez nje
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

    // 2) wallets -> currency_id
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

    // 3) currency -> symbol
    const { data: currencies, error: cErr } = await supabase
      .from("currencies")
      .select("id, symbol")
      .in("id", currencyIds);
    if (cErr) return NextResponse.json({ ok: false, error: cErr.message }, { status: 500 });

    const currencyToSymbol: Record<string | number, string> = {};
    for (const c of (currencies || []) as CurrencyRow[]) {
      if (c?.id != null && c?.symbol) currencyToSymbol[c.id] = c.symbol.toUpperCase();
    }

    // 4) mapiranje u response
    const result = rows.map((r) => {
      const curId = walletToCurrency[r.wallet_id];
      const symbol = currencyToSymbol[curId] || null;
      return {
        chain: symbol,                   // 'ETH', 'POL', ...
        amount: r.amount ?? null,        // nativna količina
        amount_usd: r.amount_usd ?? null,// USD vrijednost (može biti null ako fx-sync još nije popunio)
        tx: r.tx_hash ?? null,           // hash transakcije
        timestamp: r.timestamp ?? null,  // ako kolona postoji
      };
    });

    return NextResponse.json({ ok: true, total: result.length, rows: result });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

