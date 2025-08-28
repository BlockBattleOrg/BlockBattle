// app/api/ingest/contrib/ada/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type Json = Record<string, any>;
const DECIMALS = 6; // lovelace -> ADA
const PAGE_COUNT = 100;
const MAX_PAGES = Number(process.env.ADA_PAGES || "6"); // koliko stranica po walletu max

function J(body: Json = {}, status = 200) {
  return NextResponse.json(body, { status });
}
function ok(body: Json = {}) {
  return J({ ok: true, ...body });
}
function err(msg: string, status = 500, extra?: Json) {
  return J({ ok: false, error: msg, ...(extra || {}) }, status);
}
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

// ----- NowNodes Blockfrost proxy -----
function bfBase(): string {
  // očekujemo ADA_BLOCKFROST_URL = https://ada-blockfrost.nownodes.io
  const host = (process.env.ADA_BLOCKFROST_URL || "https://ada-blockfrost.nownodes.io").replace(/\/+$/, "");
  return `${host}/api/v0`;
}
function bfHeaders(): Record<string, string> {
  const key = need("NOWNODES_API_KEY");
  // Šaljemo i NowNodes i Blockfrost-style header
  return {
    "api-key": key,
    "project_id": key,
  };
}
async function bfGET<T = any>(path: string): Promise<T> {
  const url = `${bfBase()}${path}`;
  const res = await fetch(url, { method: "GET", headers: bfHeaders(), cache: "no-store" });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`ADA HTTP ${res.status} ${text || ""}`.trim());
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`ADA JSON parse error for ${url}: ${text.slice(0, 300)}`);
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
    need("NOWNODES_API_KEY");
    // ADA_BLOCKFROST_URL je opcionalan (postoji default)

    const sb = supa();

    // aktivni Cardano walleti
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true)
      .eq("chain", "cardano");
    if (wErr) throw wErr;
    const active = (wallets || []).filter((w) => !!w.address);
    if (!active.length) return ok({ scanned: 0, inserted: 0, note: "No active Cardano wallets" });

    // cursor u settings
    const CUR = "ada_contrib_last_scanned";
    const { data: st } = await sb.from("settings").select("value").eq("key", CUR).maybeSingle();
    const prev = Number(st?.value?.n ?? 0);

    // latest height
    const latestBlk = await bfGET<{ height: number }>("/blocks/latest");
    const latest = Number(latestBlk?.height || 0);
    if (!latest) return err("ADA: failed to resolve latest block");

    let scannedCalls = 0;
    let candidates = 0;

    const rows: Array<{
      wallet_id: string;
      tx_hash: string;
      amount: number;
      amount_usd: number | null;
      block_time: string;
    }> = [];

    for (const w of active) {
      const addr = String(w.address);
      let page = 1;

      // dohvat transakcija BEZ 'from/to' filtera (kompatibilnost s proxyjem)
      while (page <= MAX_PAGES) {
        scannedCalls++;
        const list = await bfGET<any[]>(
          `/addresses/${addr}/transactions?order=asc&count=${PAGE_COUNT}&page=${page}`
        );
        if (!Array.isArray(list) || !list.length) break;

        for (const item of list) {
          const txHash = String(item?.tx_hash || "");
          if (!txHash) continue;

          // detalji transakcije (visina i vrijeme)
          const tx = await bfGET<any>(`/txs/${txHash}`);
          const block_time = Number(tx?.block_time || Date.now());
          const whenISO = new Date(block_time * 1000).toISOString();

          // utxos -> zbroji lovelace isplaćen na našu adresu
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
            candidates++;
            rows.push({
              wallet_id: String(w.id),
              tx_hash: txHash,
              amount: Number(sum) / 10 ** DECIMALS,
              amount_usd: null,
              block_time: whenISO,
            });
          }
        }

        if (list.length < PAGE_COUNT) break;
        page++;
      }
    }

    // de-dupe po (tx_hash, wallet_id)
    let existing = new Set<string>();
    if (rows.length) {
      const uniq = Array.from(new Set(rows.map((r) => r.tx_hash)));
      const { data: ex } = await sb.from("contributions").select("tx_hash,wallet_id").in("tx_hash", uniq);
      existing = new Set((ex || []).map((e: any) => `${e.tx_hash}:${e.wallet_id}`));
    }
    const toInsert = rows.filter((r) => !existing.has(`${r.tx_hash}:${r.wallet_id}`));
    if (toInsert.length) {
      const { error: insErr } = await sb.from("contributions").insert(toInsert);
      if (insErr) throw insErr;
    }

    // spremi cursor – gurni na 'latest' da napredujemo
    await sb.from("settings").upsert({ key: CUR, value: { n: latest }, updated_at: new Date().toISOString() });

    return ok({
      latest,
      prev,
      scanned: scannedCalls,
      candidates: rows.length,
      inserted: toInsert.length,
      base: bfBase(),
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

