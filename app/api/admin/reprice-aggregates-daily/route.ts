// app/api/admin/reprice-aggregates-daily/route.ts
// Reprice ONLY aggregates_daily.total_amount_usd = total_amount * FX(symbol)
// - Secure via header: x-cron-secret: process.env.CRON_SECRET
// - Input FX via query ?fx=BTC:60123.2,ETH:1625.4,... (CoinGecko map built in workflow)
// - Optional: ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: all time)
// Notes:
//   * Does NOT touch `contributions`.
//   * Uses SERVICE_ROLE key (server-only).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type UUID = string;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ENV: ${name}`);
  return v;
}
function admin() {
  return createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}
function parseFxMap(raw: string | null) {
  // "ETH:1625.3,BTC:60000" -> Map("ETH" => 1625.3, "BTC" => 60000)
  const m = new Map<string, number>();
  if (!raw) return m;
  for (const pair of raw.split(",")) {
    const [sym, val] = pair.split(":").map((s) => s.trim());
    const n = Number(val);
    if (sym && Number.isFinite(n)) m.set(sym.toUpperCase(), n);
  }
  return m;
}
function toDate(d?: string | null) {
  if (!d) return null;
  const [Y, M, D] = d.split("-").map(Number);
  if (!Y || !M || !D) return null;
  return `${String(Y).padStart(4, "0")}-${String(M).padStart(2, "0")}-${String(D).padStart(2, "0")}`;
}

export async function POST(req: NextRequest) {
  // Auth
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const fxMap = parseFxMap(url.searchParams.get("fx"));
  const from = toDate(url.searchParams.get("from")); // inclusive
  const to = toDate(url.searchParams.get("to"));     // inclusive

  if (fxMap.size === 0) {
    return NextResponse.json({ ok: false, error: "empty fx map" }, { status: 400 });
  }

  const sb = admin();

  try {
    // 1) currencies lookup (id -> symbol)
    const { data: currencies, error: curErr } = await sb.from("currencies").select("id, symbol");
    if (curErr) throw curErr;
    const idToSymbol = new Map<UUID, string>();
    for (const c of currencies || []) idToSymbol.set(c.id as UUID, String(c.symbol).toUpperCase());

    // 2) Pull aggregates_daily (optionally date bounded)
    let q = sb.from("aggregates_daily").select("id, currency_id, day, total_amount");
    if (from) q = q.gte("day", from);
    if (to) q = q.lte("day", to);
    const { data: rows, error: aggErr } = await q;
    if (aggErr) throw aggErr;

    if (!rows || rows.length === 0) {
      return NextResponse.json({ ok: true, updated: 0, skipped: 0, from, to });
    }

    // 3) Compute updates (skip if FX missing for symbol)
    const updates: { id: number; total_amount_usd: number }[] = [];
    let skipped = 0;

    for (const r of rows as any[]) {
      const sym = idToSymbol.get(r.currency_id as UUID);
      if (!sym) {
        skipped++;
        continue;
      }
      const fx = fxMap.get(sym);
      if (fx === undefined) {
        // no FX for this symbol in the provided map → skip silently
        skipped++;
        continue;
      }
      const nativeAmt = Number(r.total_amount ?? 0) || 0;
      updates.push({ id: r.id as number, total_amount_usd: nativeAmt * fx });
    }

    // 4) Batch update (in chunks)
    const chunk = 500;
    for (let i = 0; i < updates.length; i += chunk) {
      const slice = updates.slice(i, i + chunk);
      await Promise.all(
        slice.map((u) =>
          sb.from("aggregates_daily").update({ total_amount_usd: u.total_amount_usd }).eq("id", u.id)
        )
      );
    }

    return NextResponse.json({
      ok: true,
      from: from ?? "ALL",
      to: to ?? "ALL",
      updated: updates.length,
      skipped, // rows without FX or symbol
      symbolsInFx: Array.from(fxMap.keys()),
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

