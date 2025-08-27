// app/api/admin/rollup/contributions/daily/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

type CurrencyRow = { id: string; symbol: string };

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
function addDays(iso: string, n: number) {
  const d = new Date(iso + "T00:00:00.000Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}
function startOfDayISO(iso: string) {
  return iso + "T00:00:00.000Z";
}
function endOfDayISO(iso: string) {
  // [day, day+1)
  const next = addDays(iso, 1);
  return next + "T00:00:00.000Z";
}

// normalizacija oznaka lanca → currencies.symbol u bazi
function normSymbol(sym?: string | null, chain?: string | null) {
  const s = String(sym || "").trim().toUpperCase();
  const c = String(chain || "").trim().toUpperCase();
  if (s) {
    if (s === "POLYGON" || s === "POL") return "MATIC";
    return s;
  }
  if (c === "POLYGON" || c === "MATIC" || c === "POL") return "MATIC";
  if (c === "OPTIMISM" || c === "OP") return "OP";
  if (c === "ARBITRUM" || c === "ARBITRUM ONE" || c === "ARB" || c.replace(/\s+/g, "") === "ARBITRUMONE") return "ARB";
  if (c === "AVALANCHE" || c === "CCHAIN" || c === "AVAX") return "AVAX";
  // fallback: koristi chain kao symbol
  return c || "";
}

function relFirst<T = any>(maybe: any): T | undefined {
  if (!maybe) return undefined;
  return Array.isArray(maybe) ? maybe[0] : maybe;
}

export async function POST(req: Request) {
  try {
    // auth
    const hdr = req.headers.get("x-cron-secret") || "";
    if (!CRON_SECRET || hdr !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // učitaj sve valute -> mapa symbol -> id
    const { data: curRows, error: curErr } = await sb
      .from("currencies")
      .select("id, symbol");
    if (curErr) throw curErr;

    const curMap = new Map<string, string>();
    for (const r of (curRows || []) as CurrencyRow[]) {
      curMap.set(String(r.symbol).toUpperCase(), r.id);
    }

    // prozor dana: od posljednjeg obrađenog + 1 do danas (UTC), max 7 dana po runu
    const today = isoDay(new Date()); // UTC danas
    const MAX_DAYS = 7;

    const KEY = "contrib_daily_last_day";
    const { data: sRow } = await sb.from("settings").select("value").eq("key", KEY).maybeSingle();
    const lastDay = String((sRow?.value as any)?.day || "");

    // startDay
    let startDay = lastDay ? addDays(lastDay, 1) : addDays(today, -2); // ako nema stanja, uzmi zadnja 2 dana
    // cap na MAX_DAYS
    const daysToProcess: string[] = [];
    let cursor = startDay;
    while (cursor <= today && daysToProcess.length < MAX_DAYS) {
      daysToProcess.push(cursor);
      cursor = addDays(cursor, 1);
    }
    if (daysToProcess.length === 0) {
      return NextResponse.json({ ok: true, info: "Nothing to roll up today.", processed: 0, inserted: 0 });
    }

    let totalInserted = 0;

    // za svaki dan: agregacija i upis
    for (const day of daysToProcess) {
      const fromISO = startOfDayISO(day);
      const toISO = endOfDayISO(day);

      // povuci kontribucije tog dana (join na wallet i currencies radi simbola)
      const { data, error } = await sb
        .from("contributions")
        .select(`
          amount, amount_usd, block_time,
          wallet:wallet_id (
            id, chain, currency_id,
            currencies:currency_id ( id, symbol )
          )
        `)
        .gte("block_time", fromISO)
        .lt("block_time", toISO);

      if (error) throw error;

      type Agg = { total: number; total_usd: number; count: number };
      const perCurrency = new Map<string, Agg>(); // currency_id -> agg

      for (const row of (data || [])) {
        const w: any = (row as any).wallet;
        const curRel = relFirst(w?.currencies);
        let currencyId: string | null = String(w?.currency_id || "") || null;

        if (!currencyId) {
          // probaj preko currencies relacije
          currencyId = curRel?.id || null;
        }
        if (!currencyId) {
          // probaj preko normaliziranog simbola iz chain/symbol i curMap
          const sym = normSymbol(curRel?.symbol, w?.chain);
          const id = curMap.get(sym);
          if (id) currencyId = id;
        }
        if (!currencyId) continue; // ne možemo uvezati u aggregates_daily

        const key = currencyId;
        const a = perCurrency.get(key) || { total: 0, total_usd: 0, count: 0 };
        a.total += Number((row as any).amount || 0);
        a.total_usd += Number((row as any).amount_usd || 0); // vjerojatno 0 trenutno
        a.count += 1;
        perCurrency.set(key, a);
      }

      // upis: bez unique constrainta radimo delete+insert za (day, currency_id)
      for (const [currencyId, agg] of perCurrency.entries()) {
        await sb
          .from("aggregates_daily")
          .delete()
          .match({ day, currency_id: currencyId });

        const { error: insErr } = await sb.from("aggregates_daily").insert({
          currency_id: currencyId,
          day,
          total_amount: agg.total,
          total_amount_usd: agg.total_usd || 0,
          tx_count: agg.count,
        });
        if (insErr) throw insErr;
        totalInserted += 1;
      }

      // spremi napredak po danu
      await sb.from("settings").upsert({ key: KEY, value: { day } }, { onConflict: "key" });
    }

    return NextResponse.json({
      ok: true,
      processed: daysToProcess.length,
      last_processed_day: daysToProcess[daysToProcess.length - 1],
      inserted: totalInserted,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Daily rollup failed" }, { status: 500 });
  }
}

