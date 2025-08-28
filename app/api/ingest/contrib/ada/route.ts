// app/api/ingest/contrib/ada/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type Json = Record<string, any>;
const DECIMALS = 6; // lovelace -> ADA

function ok(body: Json = {}) {
  return NextResponse.json({ ok: true, ...body });
}
function err(msg: string, code = 500) {
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

// ----- NowNodes Blockfrost proxy (REST v0) -----
function bfBase(): string {
  // očekujemo ADA_BLOCKFROST_URL = https://ada-blockfrost.nownodes.io
  const host = (process.env.ADA_BLOCKFROST_URL || "https://ada-blockfrost.nownodes.io").replace(/\/+$/, "");
  return `${host}/api/v0`;
}
function bfHeaders(): Record<string, string> {
  const key = need("NOWNODES_API_KEY");
  // NowNodes koristi 'api-key' header (ne Blockfrost 'project_id')
  return { "api-key": key };
}
async function bfGET<T = any>(path: string): Promise<T> {
  const res = await fetch(`${bfBase()}${path}`, {
    method: "GET",
    headers: bfHeaders(),
    cache: "no-store",
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`ADA HTTP ${res.status} ${txt}`);
  }
  return (await res.json()) as T;
}

export async function POST(req: Request) {
  try {
    // auth
    const expected = need("CRON_SECRET");
    const got = req.headers.get("x-cron-secret") || "";
    if (got !== expected) return err("Unauthorized", 401);

    // env guard (NowNodes only)
    need("NOWNODES_API_KEY");
    // ADA_BLOCKFROST_URL je opcionalan (ima default), ali je dobro da postoji na Vercelu

    const sb = supa();

    // 1) aktivni Cardano walleti (chain='cardano')
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true)
      .eq("chain", "cardano");
    if (wErr) throw wErr;

    const active = (wallets || []).filter((w) => typeof w.address === "string" && w.address);
    if (active.length === 0) return ok({ scanned: 0, inserted: 0, note: "No active Cardano wallets" });

    // 2) cursor u settings ('ada_contrib_last_scanned' = height)
    const CUR = "ada_contrib_last_scanned";
    const { data: st } = await sb.from("settings").select("value").eq("key", CUR).maybeSingle();
    let last = Number(st?.value?.n ?? 0);

    // latest height
    const latestBlk = await bfGET<{ height: number }>("/blocks/latest");
    const latest = Number(latestBlk?.height || 0);
    if (!latest) return err("ADA: failed to resolve latest block");

    if (!last || last <= 0) last = Math.max(0, latest - 20000); // prvi run

    const SPAN = Number(process.env.ADA_BLOCK_SPAN || "8000");
    const from = last + 1;
    const to = Math.min(latest, last + SPAN);
    if (to < from) return ok({ latest, from: last, to: last, scanned: 0, inserted: 0 });

    let scanned = 0;
    const rows: Array<{
      wallet_id: string;
      tx_hash: string;
      amount: number;
      amount_usd: number | null;
      block_time: string;
    }> = [];

    // 3) scan transakcija po walletu (Blockfrost pathovi)
    for (const w of active) {
      const addr = String(w.address);
      let page = 1;
      const COUNT = 100;

      while (true) {
        scanned++;
        // Podržano: order, page, count, from, to (block height)
        const list = await bfGET<any[]>(
          `/addresses/${addr}/transactions?order=asc&count=${COUNT}&page=${page}&from=${from}&to=${to}`
        );
        if (!Array.isArray(list) || list.length === 0) break;

        for (const item of list) {
          const txHash = String(item?.tx_hash || "");
          if (!txHash) continue;

          // block_time
          const tx = await bfGET<any>(`/txs/${txHash}`);
          const block_time = Number(tx?.block_time || Date.now());
          const whenISO = new Date(block_time * 1000).toISOString();

          // outputs i naša adresa
          const utxos = await bfGET<any>(`/txs/${txHash}/utxos`);
          const outputs: any[] = utxos?.outputs || [];
          if (!outputs.length) continue;

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
            rows.push({
              wallet_id: String(w.id),
              tx_hash: txHash,
              amount: Number(sumLovelace) / 10 ** DECIMALS,
              amount_usd: null,
              block_time: whenISO,
            });
          }
        }

        if (list.length < COUNT) break;
        page += 1;
      }
    }

    // 4) de-dup (tx_hash, wallet_id)
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

    // 5) spremi cursor
    await sb.from("settings").upsert({ key: CUR, value: { n: to }, updated_at: new Date().toISOString() });

    return ok({
      latest,
      from,
      to,
      scanned,
      candidates: rows.length,
      inserted: toInsert.length,
      base: bfBase(),
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

