// app/api/admin/rollup-contributions-daily/route.ts
// Rebuild daily aggregates from `contributions` into `aggregates_daily` for a given date window.
// Security: header x-cron-secret must match process.env.CRON_SECRET

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

function toUTCDateString(d: Date) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function dayStartISO(d: Date) {
  return `${toUTCDateString(d)}T00:00:00.000Z`;
}
function dayEndISO(d: Date) {
  return `${toUTCDateString(d)}T23:59:59.999Z`;
}
function addDaysUTC(d: Date, n: number) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (!secret || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const fromParam = url.searchParams.get("from"); // YYYY-MM-DD
  const toParam = url.searchParams.get("to");     // YYYY-MM-DD
  const backfillDaysParam = url.searchParams.get("backfillDays");

  // Odredi raspon
  const today = new Date();
  const yesterday = addDaysUTC(today, -1);

  let fromDate: Date | null = null;
  let toDate: Date = yesterday;

  if (fromParam) {
    const [Y, M, D] = fromParam.split("-").map(Number);
    fromDate = new Date(Date.UTC(Y, (M || 1) - 1, D || 1));
  }
  if (toParam) {
    const [Y, M, D] = toParam.split("-").map(Number);
    toDate = new Date(Date.UTC(Y, (M || 1) - 1, D || 1));
  }

  if (!fromDate && backfillDaysParam) {
    const n = Math.max(1, Number(backfillDaysParam) || 1);
    fromDate = addDaysUTC(yesterday, -n + 1);
  }
  if (!fromDate) {
    // default: ALL-TIME (od prvog doprinosa); praktično: 1970-01-01 do jučer
    fromDate = new Date(Date.UTC(1970, 0, 1));
  }

  if (fromDate > toDate) {
    return NextResponse.json({ ok: false, error: "invalid range (from>to)" }, { status: 400 });
  }

  const sb = admin();

  try {
    // Cache: wallet_id -> currency_id
    const { data: wallets, error: wErr } = await sb.from("wallets").select("id, currency_id");
    if (wErr) throw wErr;
    const walletToCurrency = new Map<UUID, UUID>();
    for (const w of wallets || []) if (w.currency_id) walletToCurrency.set(w.id as UUID, w.currency_id as UUID);

    // Popis dana
    const days: string[] = [];
    for (let d = new Date(fromDate); d <= toDate; d = addDaysUTC(d, 1)) {
      days.push(toUTCDateString(d));
    }

    // 1) Obriši postojeće agregate u rasponu
    if (days.length > 0) {
      const { error: delErr } = await sb
        .from("aggregates_daily")
        .delete()
        .gte("day", days[0])
        .lte("day", days[days.length - 1]);
      if (delErr) throw delErr;
    }

    // 2) Povuci contributions za cijeli raspon
    const { data: contribs, error: cErr } = await sb
      .from("contributions")
      .select("wallet_id, amount, amount_usd, block_time")
      .gte("block_time", dayStartISO(fromDate))
      .lte("block_time", dayEndISO(toDate));
    if (cErr) throw cErr;

    // 3) Grupiraj po (day, currency_id)
    type Acc = { total_amount: number; total_amount_usd: number; tx_count: number };
    const byDayCurrency = new Map<string, Acc>(); // key: `${day}|${currency_id}`

    for (const r of contribs || []) {
      const wid = r.wallet_id as UUID | null;
      if (!wid) continue;
      const cid = walletToCurrency.get(wid);
      if (!cid) continue;

      const dt = new Date(r.block_time);
      const day = toUTCDateString(dt);
      const key = `${day}|${cid}`;

      const acc = byDayCurrency.get(key) || { total_amount: 0, total_amount_usd: 0, tx_count: 0 };
      acc.total_amount += Number(r.amount ?? 0) || 0;
      acc.total_amount_usd += Number(r.amount_usd ?? 0) || 0;
      acc.tx_count += 1;
      byDayCurrency.set(key, acc);
    }

    // 4) Insert payload (chunked)
    const payload: any[] = [];
    for (const [key, v] of byDayCurrency) {
      const [day, currency_id] = key.split("|");
      payload.push({
        day,
        currency_id,
        total_amount: v.total_amount,
        total_amount_usd: v.total_amount_usd,
        tx_count: v.tx_count,
      });
    }

    if (payload.length > 0) {
      const chunk = 1000;
      for (let i = 0; i < payload.length; i += chunk) {
        const { error: insErr } = await sb.from("aggregates_daily").insert(payload.slice(i, i + chunk));
        if (insErr) throw insErr;
      }
    }

    return NextResponse.json({
      ok: true,
      from: toUTCDateString(fromDate),
      to: toUTCDateString(toDate),
      days: days.length,
      inserted: payload.length,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

