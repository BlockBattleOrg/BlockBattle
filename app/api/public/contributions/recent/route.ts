// app/api/public/contributions/recent/route.ts
// Recent contributions: last N rows with { chain, amount, amount_usd, tx, timestamp, note }.
// Ako amount_usd == NULL, USD se računa on-the-fly kao amount * spotPrice iz lib/fx.ts.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { fetchUsdPrices } from "@/lib/fx";
import { canonChain } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// Supabase client (prefer SERVICE_ROLE na serveru, ANON kao fallback za dev)
function getSupabase() {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "";
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

// wallets može doći kao objekt ili array (ovisno o joinu)
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
    const limit =
      Number.isFinite(limitParam) && limitParam > 0
        ? Math.min(limitParam, 100)
        : 10;

    const supabase = getSupabase();

    // 1) Čitanje zadnjih N kontribucija (+ note)
    let dataRows: any[] = [];
    {
      const baseSelect = `
        id,
        wallet_id,
        amount,
        amount_usd,
        tx_hash,
        block_time,
        inserted_at,
        note,
        wallets:wallet_id (
          chain,
          currencies:currency_id ( symbol )
        )
      `;

      const { data, error } = await supabase
        .from("contributions")
        .select(baseSelect)
        .order("inserted_at", { ascending: false })
        .limit(limit);

      if (error) {
        // fallback na ordering po id-u (u slučaju da inserted_at nije indeksiran)
        const { data: data2, error: err2 } = await supabase
          .from("contributions")
          .select(baseSelect)
          .order("id", { ascending: false })
          .limit(limit);
        if (err2) {
          return NextResponse.json(
            { ok: false, error: err2.message },
            { status: 500 }
          );
        }
        dataRows = data2 || [];
      } else {
        dataRows = data || [];
      }
    }

    if (!dataRows.length) {
      return NextResponse.json({ ok: true, total: 0, rows: [] });
    }

    // 2) Priprema liste simbola kojima treba spot cijena
    const needed = new Set<string>();
    for (const r of dataRows) {
      if (r.amount_usd == null && r.amount != null) {
        const { symbol, chain } = extractSymbolOrChain(r.wallets);
        const s = canonChain(symbol || chain || "");
        if (s) needed.add(s);
      }
    }

    // 3) Dohvat USD cijena
    let prices: Record<string, number> = {};
    if (needed.size > 0) {
      prices = await fetchUsdPrices(Array.from(needed));
    }

    // 4) Normalizacija odgovora
    const rows = dataRows.map((r) => {
      const { symbol, chain } = extractSymbolOrChain(r.wallets);
      const ch = canonChain(symbol || chain || "UNKNOWN")!;
      const amt =
        r.amount == null || Number.isNaN(Number(r.amount))
          ? null
          : Number(r.amount);

      // Ako amount_usd nema, izračunaj ga jednostavno: native * spot
      // (fetchUsdPrices vraća cijenu po 1 nativnoj jedinici)
      let usd =
        r.amount_usd == null || Number.isNaN(Number(r.amount_usd))
          ? null
          : Number(r.amount_usd);
      if ((usd == null || !isFinite(usd)) && amt != null) {
        const px = prices[ch];
        if (typeof px === "number" && isFinite(px)) {
          usd = amt * px;
        }
      }

      return {
        chain: ch,                         // npr. ETH, BTC, POL, BSC, …
        amount: amt,                       // nativna jedinica (kako je spremljeno u DB)
        amount_usd: usd == null ? null : Number(usd),
        tx: r.tx_hash ?? "",
        timestamp: (r.block_time as string) || (r.inserted_at as string) || "",
        note: r.note ?? null,              // << NOVO: poruka iz claim-a
      };
    });

    return NextResponse.json({ ok: true, total: rows.length, rows });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 }
    );
  }
}

