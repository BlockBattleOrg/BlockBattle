// app/api/ingest/contrib/ada/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type Json = Record<string, any>;
const DECIMALS = 6; // ADA: lovelace -> ADA (1e6)

function jok(body: Json = {}) {
  return NextResponse.json({ ok: true, ...body });
}
function jerr(msg: string, code = 500) {
  return NextResponse.json({ ok: false, error: msg }, { status: code });
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

// --- Blockfrost helpers ---
async function bf<T = any>(path: string): Promise<T> {
  const base = need("ADA_BLOCKFROST_URL").replace(/\/+$/, "");
  const key = need("ADA_BLOCKFROST_KEY");
  const res = await fetch(`${base}${path}`, {
    headers: { project_id: key },
    // Blockfrost je GET-only za ove rute
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Blockfrost HTTP ${res.status} ${txt}`);
  }
  return (await res.json()) as T;
}

export async function POST(req: Request) {
  try {
    // --- auth (cron secret) ---
    const expected = need("CRON_SECRET");
    const got = req.headers.get("x-cron-secret") || "";
    if (got !== expected) return jerr("Unauthorized", 401);

    // env guards
    need("ADA_BLOCKFROST_URL");
    need("ADA_BLOCKFROST_KEY");

    const sb = supa();

    // 1) Uzmi aktivne Cardano novčanike
    //   chain u tvojoj bazi je "cardano" (prema tablici wallets)
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true)
      .eq("chain", "cardano");

    if (wErr) throw wErr;
    const active = (wallets || []).filter((w) => typeof w.address === "string" && w.address);

    if (active.length === 0) {
      return jok({ scanned: 0, inserted: 0, note: "No active Cardano wallets" });
    }

    // 2) Cursor u settings: 'ada_contrib_last_scanned' (po block height-u)
    const CUR = "ada_contrib_last_scanned";
    const { data: st } = await sb.from("settings").select("value").eq("key", CUR).maybeSingle();
    let last = Number(st?.value?.n ?? 0);

    // latest block height
    const latestBlk = await bf<{ height: number }>("/blocks/latest");
    const latest = Number(latestBlk?.height || 0);
    if (!latest) return jerr("ADA: failed to resolve latest block");

    // init (prvi put) — skeniraj malo unatrag da ne propustimo ništa
    if (!last || last <= 0) last = Math.max(0, latest - 20000);

    // Koliko blokova max po jednoj rundi (po želji spusti/diži)
    const SPAN = Number(process.env.ADA_BLOCK_SPAN || "8000");
    const from = last + 1;
    const to = Math.min(latest, last + SPAN);
    if (to < from) {
      return jok({ latest, from: last, to: last, scanned: 0, inserted: 0 });
    }

    let inserted = 0;
    let scanned = 0;
    const rows: Array<{
      wallet_id: string;
      tx_hash: string;
      amount: number;
      amount_usd: number | null;
      block_time: string;
    }> = [];

    // 3) Za svaku adresu uzmi transakcije u rasponu [from..to]
    //    Blockfrost: /addresses/{address}/transactions?from={heightFrom}&to={heightTo}&order=asc&count=100
    //    Zatim za svaku tx: /txs/{hash}/utxos (outputs) + /txs/{hash} (block_time)
    for (const w of active) {
      const addr = String(w.address);
      let page = 1;
      const COUNT = 100;

      // Blockfrost vraća paginirano; page parametar je ?page=x
      while (true) {
        scanned++;
        const list = await bf<any[]>(
          `/addresses/${addr}/transactions?from=${from}&to=${to}&order=asc&count=${COUNT}&page=${page}`
        );

        if (!Array.isArray(list) || list.length === 0) break;

        for (const item of list) {
          const txHash = String(item?.tx_hash || item?.tx_hash?.toString() || "");
          if (!txHash) continue;

          // detalji tx-a (block_time)
          const tx = await bf<any>(`/txs/${txHash}`);
          const block_time = Number(tx?.block_time || Date.now());
          const whenISO = new Date(block_time * 1000).toISOString();

          // utxos -> outputs i filtriraj one prema adresi
          const utxos = await bf<any>(`/txs/${txHash}/utxos`);
          const outputs: any[] = utxos?.outputs || [];
          if (!outputs.length) continue;

          // Zbroji ADA (lovelace) na toj adresi.
          let sumLovelace = 0n;
          for (const out of outputs) {
            if (String(out?.address) !== addr) continue;
            const amounts: any[] = out?.amount || [];
            for (const a of amounts) {
              if (a?.unit === "lovelace") {
                const qty = BigInt(a?.quantity || "0");
                sumLovelace += qty;
              }
            }
          }

          if (sumLovelace > 0n) {
            const amountADA = Number(sumLovelace) / 10 ** DECIMALS;
            rows.push({
              wallet_id: String(w.id),
              tx_hash: txHash,
              amount: amountADA,
              amount_usd: null,
              block_time: whenISO,
            });
          }
        }

        if (list.length < COUNT) break; // nema više stranica
        page += 1;
      }
    }

    // 4) upis u contributions
    if (rows.length) {
      const { error: insErr } = await sb.from("contributions").insert(rows);
      if (insErr) throw insErr;
      inserted = rows.length;
    }

    // 5) spremi cursor
    await sb
      .from("settings")
      .upsert({ key: CUR, value: { n: to }, updated_at: new Date().toISOString() });

    return jok({ latest, from, to, scanned, inserted });
  } catch (e: any) {
    return jerr(e?.message || String(e), 500);
  }
}

