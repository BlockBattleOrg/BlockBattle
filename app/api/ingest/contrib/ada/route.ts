// app/api/ingest/contrib/ada/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

// ---------- Tuning (ENV override) ----------
const DECIMALS = 6; // lovelace -> ADA

const PAGE_COUNT = Number(process.env.ADA_PAGE_COUNT || "25");
const MAX_PAGES  = Number(process.env.ADA_MAX_PAGES  || "1");    // mala runda po walletu
const TIMEOUT_MS = Number(process.env.ADA_HTTP_TIMEOUT_MS || "25000");
const RETRIES    = Number(process.env.ADA_HTTP_RETRIES    || "3");
const SLEEP_MS   = Number(process.env.ADA_SLEEP_MS        || "200"); // throttle izmedu poziva

const CURSOR_KEY = "ada_contrib_last_scanned";

// ---------- helpers ----------
type Json = Record<string, any>;
const ok  = (b: Json = {}) => NextResponse.json({ ok: true,  ...b });
const err = (m: string, status = 500, extra?: Json) =>
  NextResponse.json({ ok: false, error: m, ...(extra || {}) }, { status });

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function need(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}
function supa() {
  const url = need("NEXT_PUBLIC_SUPABASE_URL");
  const key = need("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

// ---------- NowNodes Blockfrost proxy ----------
// VAŽNO: baza je već Blockfrost, NEMA /api/v0
function bfBase(): string {
  return (process.env.ADA_BLOCKFROST_URL || "https://ada-blockfrost.nownodes.io").replace(/\/+$/, "");
}
function bfHeaders(): Record<string, string> {
  const key = need("NOWNODES_API_KEY");
  return { "api-key": key, "project_id": key };
}

// fetch s timeoutom + retry (za 52x/504/524 i AbortError)
async function bfGET<T = any>(path: string, attempt = 0): Promise<T> {
  const url = `${bfBase()}${path.startsWith("/") ? path : `/${path}`}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, { method: "GET", headers: bfHeaders(), cache: "no-store", signal: controller.signal });
    const text = await res.text();
    clearTimeout(t);

    if (!res.ok) {
      const retriable = [502, 503, 504, 524].includes(res.status);
      if (retriable && attempt < RETRIES) {
        const backoff = 500 * Math.pow(2, attempt); // 0.5s, 1s, 2s
        await sleep(backoff);
        return bfGET<T>(path, attempt + 1);
      }
      throw new Error(`ADA HTTP ${res.status} ${text || ""}`.trim());
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`ADA JSON parse error for ${url}: ${text.slice(0, 300)}`);
    }
  } catch (e: any) {
    clearTimeout(t);
    const msg = String(e?.message || e);
    const isAbort = msg.toLowerCase().includes("abort");
    if ((isAbort || msg.includes("fetch failed")) && attempt < RETRIES) {
      const backoff = 500 * Math.pow(2, attempt);
      await sleep(backoff);
      return bfGET<T>(path, attempt + 1);
    }
    throw e;
  }
}

export async function POST(req: Request) {
  try {
    // auth
    const expected = need("CRON_SECRET");
    if ((req.headers.get("x-cron-secret") || "") !== expected) {
      return err("Unauthorized", 401);
    }

    // env guard
    need("NOWNODES_API_KEY"); // ADA_BLOCKFROST_URL opcionalan (default gore)

    const sb = supa();

    // aktivni Cardano walleti
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true)
      .eq("chain", "cardano");
    if (wErr) throw wErr;

    const active = (wallets || []).filter(w => !!w.address);
    if (!active.length) return ok({ scanned: 0, inserted: 0, note: "No active Cardano wallets" });

    // cursor (telemetrija)
    const { data: st } = await sb.from("settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
    const prev = Number(st?.value?.n ?? 0);

    // latest height (telemetrija)
    const latestBlk = await bfGET<{ height?: number }>("/blocks/latest");
    const latest = Number(latestBlk?.height || 0);

    let apiCalls = 0;
    const rows: Array<{ wallet_id: string; tx_hash: string; amount: number; amount_usd: number | null; block_time: string; }> = [];

    for (const w of active) {
      const addr = String(w.address);
      let page = 1;

      while (page <= MAX_PAGES) {
        apiCalls++;
        const list = await bfGET<any[]>(
          `/addresses/${addr}/transactions?order=desc&count=${PAGE_COUNT}&page=${page}`
        );
        if (!Array.isArray(list) || !list.length) break;

        for (const item of list) {
          const txHash = String(item?.tx_hash || "");
          if (!txHash) continue;

          // meta (za block_time)
          apiCalls++;
          await sleep(SLEEP_MS);
          const tx = await bfGET<any>(`/txs/${txHash}`);
          const block_time = Number(tx?.block_time || Date.now());
          const whenISO = new Date(block_time * 1000).toISOString();

          // utxos -> zbroji lovelace prema našem adresatu
          apiCalls++;
          await sleep(SLEEP_MS);
          const utxos = await bfGET<any>(`/txs/${txHash}/utxos`);
          const outputs: any[] = utxos?.outputs || [];
          if (!outputs.length) continue;

          let sum = 0n;
          for (const out of outputs) {
            if (String(out?.address) !== addr) continue;
            const amts: any[] = out?.amount || [];
            for (const a of amts) {
              if (a?.unit === "lovelace") {
                sum += BigInt(a?.quantity || "0");
              }
            }
          }
          if (sum > 0n) {
            rows.push({
              wallet_id: String(w.id),
              tx_hash: txHash,
              amount: Number(sum) / 10 ** DECIMALS,
              amount_usd: null,
              block_time: whenISO,
            });
          }
        }

        if (list.length < PAGE_COUNT) break; // zadnja stranica
        page++;
        await sleep(SLEEP_MS);
      }
    }

    // de-dupe (tx_hash + wallet_id)
    let existing = new Set<string>();
    if (rows.length) {
      const uniq = Array.from(new Set(rows.map(r => r.tx_hash)));
      const { data: ex } = await sb.from("contributions").select("tx_hash,wallet_id").in("tx_hash", uniq);
      existing = new Set((ex || []).map((e: any) => `${e.tx_hash}:${e.wallet_id}`));
    }
    const toInsert = rows.filter(r => !existing.has(`${r.tx_hash}:${r.wallet_id}`));
    if (toInsert.length) {
      const { error: insErr } = await sb.from("contributions").insert(toInsert);
      if (insErr) throw insErr;
    }

    // spremi latest height (telemetrija)
    if (latest) {
      await sb.from("settings").upsert({ key: CURSOR_KEY, value: { n: latest }, updated_at: new Date().toISOString() });
    }

    return ok({
      latest,
      prev,
      scanned_calls: apiCalls,
      candidates: rows.length,
      inserted: toInsert.length,
      base: bfBase(),
      page_count: PAGE_COUNT,
      max_pages: MAX_PAGES,
      timeout_ms: TIMEOUT_MS,
      retries: RETRIES,
      sleep_ms: SLEEP_MS,
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

