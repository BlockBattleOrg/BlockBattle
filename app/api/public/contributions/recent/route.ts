// app/api/public/contributions/recent/route.ts
// Recent contributions: last N rows with { chain, amount, amount_usd, tx, timestamp }.
// If amount_usd is NULL, we compute USD on-the-fly using lib/fx.ts (real-time display).
// No schema changes.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchUsdPrices, toUsd } from "@/lib/fx";
import { canonChain } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Supabase client (prefer SERVICE_ROLE on server routes, fallback to ANON for dev)
function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  if (!url || !key) {
    throw new Error(
      "Missing Supabase env: need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY)."
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

// Safely extract symbol/chain from nested relation that can be object or array
function extractSymbolOrChain(rel: any): { symbol?: string; chain?: string } {
  const w = Array.isArray(rel) ? rel[0] : rel;
  if (!w) return {};
  const c = Array.isArray(w.currencies) ? w.currencies[0] : w.currencies;
  const symbol = c?.symbol ? String(c.symbol).toUpperCase() : undefined;
  const chain = w?.chain ? String(w.chain) : undefined;
  return { symbol, chain };
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const limitParam = parseInt(url.searchParams.get("limit") || "10", 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 10;

    const supabase = getSupabase();

    let dataRows: any[] = [];
    {
      const { data, error } = await supabase
        .from("contributions")
        .select(`
          id,
          wallet_id,
          amount,
          amount_usd,
          tx_hash,
          block_time,
          inserted_at,
          wallets:wallet_id (
            chain,
            currencies:currency_id (
              symbol
            )
          )
        `)
        .order("inserted_at", { ascending: false })
        .limit(limit);

      if (error) {
        const { data: data2, error: err2 } = await supabase
          .from("contributions")
          .select(`
            id,
            wallet_id,
            amount,
            amount_usd,
            tx_hash,
            block_time,
            inserted_at,
            wallets:wallet_id (
              chain,
              currencies:currency_id (
                symbol
              )
            )
          `)
          .order("id", { ascending: false })
          .limit(limit);
        if (err2) return NextResponse.json({ ok: false, error: err2.message }, { status: 500 });
        dataRows = data2 || [];
      } else {
        dataRows = data || [];
      }
    }

    if (!dataRows.length) return NextResponse.json({ ok: true, total: 0, rows: [] });

    const neededSymbols = new Set<string>();
    for (const r of dataRows) {
      if (r.amount_usd == null && r.amount != null) {
        const { symbol, chain } = extractSymbolOrChain(r.wallets);
        const s = canonChain(symbol || chain || "");
        if (s) neededSymbols.add(s);
      }
    }

    let prices: Record<string, number> = {};
    if (neededSymbols.size > 0) {
      prices = await fetchUsdPrices(Array.from(neededSymbols));
    }

    const rows = dataRows.map((r) => {
      const { symbol, chain } = extractSymbolOrChain(r.wallets);
      const ch = canonChain(symbol || chain || "UNKNOWN")!;
      let usd = r.amount_usd;
      const amtNum = r.amount == null ? null : Number(r.amount);

      if ((usd == null || Number.isNaN(Number(usd))) && amtNum != null && ch) {
        const computed = toUsd(ch, String(amtNum), /*decimals*/ 18, prices);
        if (typeof computed === "number" && isFinite(computed)) usd = computed;
      }

      return {
        chain: ch,
        amount: amtNum,
        amount_usd: usd == null ? null : Number(usd),
        tx: r.tx_hash ?? "",
        timestamp: (r.block_time as string) || (r.inserted_at as string) || "",
      };
    });

    return NextResponse.json({ ok: true, total: rows.length, rows });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || err) }, { status: 500 });
  }
}

