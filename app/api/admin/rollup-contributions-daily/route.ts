// app/api/admin/rollup-contributions-daily/route.ts
// Secured admin endpoint (x-cron-secret) that computes daily rollups from `contributions`
// and upserts into `aggregates_daily` (schema from your SQL).
// Notes:
// - Because `aggregates_daily` nema unique constraint na (day, currency_id),
//   radimo "delete for day(s) + insert" (id je PK).
// - Default radi za "jučer" (UTC). Možeš backfillati više dana s ?backfillDays=30

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type UUID = string;

type Contribution = {
  wallet_id: UUID | null;
  amount: string;       // numeric (string from PostgREST)
  amount_usd: string | null;
  block_time: string;   // timestamptz
};

type Wallet = {
  id: UUID;
  currency_id: UUID | null;
};

type Currency = {
  id: UUID;
  symbol: string; // e.g. "BTC"
};

function getAdminSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

function toUTCDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function addDaysUTC(d: Date, delta: number) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() + delta);
  return x;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const backfillDays = Math.max(1, Math.min(90, Number(url.searchParams.get("backfillDays") || "1"))); // 1..90
  // "jučer" kao gornja granica (da izbjegnemo partial day)
  const yesterday = addDaysUTC(new Date(), -1);

  const supabase = getAdminSupabase();

  try {
    // 1) Učitaj sve wallet -> currency_id (mapa)
    const { data: wallets, error: wErr } = await supabase
      .from("wallets")
      .select("id, currency_id")
      .eq("is_active", true) as unknown as { data: Wallet[] | null; error: any };

    if (wErr) throw wErr;
    const walletToCurrency = new Map<UUID, UUID>();
    for (const w of wallets || []) {
      if (w.currency_id) walletToCurrency.set(w.id, w.currency_id);
    }

    // 2) (neobvezno) mapa valuta za debug/log (nije nužno za rollup)
    const { data: currencies, error: cErr } = await supabase
      .from("currencies")
      .select("id, symbol");
    if (cErr) throw cErr;
    const currencyName = new Map<UUID, string>();
    for (const c of (currencies || []) as Currency[]) currencyName.set(c.id, c.symbol);

    // 3) Za svaki dan u backfill rasponu:
    for (let i = 0; i < backfillDays; i++) {
      const day = addDaysUTC(yesterday, -i);
      const dayStr = toUTCDateString(day);
      const dayStart = `${dayStr}T00:00:00.000Z`;
      const dayEnd = `${dayStr}T23:59:59.999Z`;

      // 3a) Povuci sve contributions tog dana (s amount i amount_usd)
      const { data: contribs, error: qErr } = await supabase
        .from("contributions")
        .select("wallet_id, amount, amount_usd, block_time")
        .gte("block_time", dayStart)
        .lte("block_time", dayEnd)
        .limit(200000); // safety cap
      if (qErr) throw qErr;

      // 3b) Grupiraj po currency_id (preko wallet_id mape)
      type Acc = { total_amount: number; total_amount_usd: number; tx_count: number };
      const byCurrency = new Map<UUID, Acc>();

      for (const row of (contribs || []) as Contribution[]) {
        if (!row.wallet_id) continue;
        const cid = walletToCurrency.get(row.wallet_id);
        if (!cid) continue;

        const acc = byCurrency.get(cid) || { total_amount: 0, total_amount_usd: 0, tx_count: 0 };
        // numeric dolazi kao string – pretvorba
        const amt = Number(row.amount ?? 0) || 0;
        const usd = Number(row.amount_usd ?? 0) || 0;
        acc.total_amount += amt;
        acc.total_amount_usd += usd;
        acc.tx_count += 1;
        byCurrency.set(cid, acc);
      }

      // 3c) Očisti postojeće redove za taj dan (jer nemamo unique constraint)
      const { error: delErr } = await supabase
        .from("aggregates_daily")
        .delete()
        .eq("day", dayStr);
      if (delErr) throw delErr;

      // 3d) Insert novih agregata
      const payload = Array.from(byCurrency.entries()).map(([cid, acc]) => ({
        currency_id: cid,
        day: dayStr,
        total_amount: acc.total_amount,
        total_amount_usd: acc.total_amount_usd,
        tx_count: acc.tx_count,
      }));

      if (payload.length > 0) {
        const { error: insErr } = await supabase.from("aggregates_daily").insert(payload);
        if (insErr) throw insErr;
      }

      // eslint-disable-next-line no-console
      console.log(
        `[rollup] ${dayStr}: inserted ${payload.length} rows`,
        payload.slice(0, 3).map(r => ({ ...r, currency: currencyName.get(r.currency_id) }))
      );
    }

    return NextResponse.json({ ok: true, backfillDays });
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.error("rollup error:", e);
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}

