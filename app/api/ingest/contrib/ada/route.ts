// app/api/ingest/contrib/ada/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type Json = Record<string, any>;
const DECIMALS = 6; // ADA: lovelace -> ADA (1e6)

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

/** NowNodes (Cardano) REST helper — GET only */
function adaBase(): string {
  const base = (process.env.ADA_API_BASE || "https://ada.nownodes.io/api/v0").replace(/\/+$/, "");
  return base;
}
function adaHeaders(): Record<string, string> {
  const key = need("NOWNODES_API_KEY");
  return { "api-key": key };
}
async function adaGET<T = any>(path: string): Promise<T> {
  const res = await fetch(`${adaBase()}${path}`, {
    method: "GET",
    headers: adaHeaders(),
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

    // env guards (Only NowNodes)
    need("ADA_API_BASE"); // ako nema, koristimo default gore
    need("NOWNODES_API_KEY");

    const sb = supa();

    // 1) Active Cardano wallets (chain='cardano')
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true)
      .eq("chain", "cardano");
    if (wErr) throw wErr;

    const active = (wallets || []).filter((w) => typeof w.address === "string" && w.address);
    if (active.length === 0) {
      return ok({ scanned: 0, inserted: 0, note: "No active Cardano wallets" });
    }

    // 2) Cursor (by height) u settings: 'ada_contrib_last_scanned'
    const CUR = "ada_contrib_last_scanned";
    const { data: st } = await sb.from("settings").select("value").eq("key", CUR).maybeSingle();
    let last = Number(st?.value?.n ?? 0);

    // latest block height (NowNodes ima Blockfrost-kompatibilan path)
    const latestBlk = await adaGET<{ height: number }>("/blocks/latest");
    const latest = Number(latestBlk?.height || 0);
    if (!latest) return err("ADA: failed to resolve latest block");

    // init (prvi run): skeniraj malo unatrag
    if (!last || last <= 0) last = Math.max(0, latest - 20000);

    const SPAN = Number(process.env.ADA_BLOCK_SPAN || "8000");
    const from = last + 1;
    const to = Math.min(latest, last + SPAN);
    if (to < from) {
      return ok({ latest, from: last, to: last, scanned: 0, inserted: 0 });
    }

    let scanned = 0;
    const rows: Array<{
      wallet_id: string;
      tx_hash: string;
      amount: number;
      amount_usd: number | null;
      block_time: string;
    }> = [];

    // 3) Per-wallet scan transakcija u [from..to]
    //    /addresses/{addr}/transactions?from=:heightFrom&to=:heightTo&order=asc&count=100&page=1
    for (const w of active) {
      const addr = String(w.address);
      let page = 1;
      const COUNT = 100;

      while (true) {
        scanned++;
        const list = await adaGET<any[]>(
          `/addresses/${addr}/transactions?from=${from}&to=${to}&order=asc&count=${COUNT}&page=${page}`
        );
        if (!Array.isArray(list) || list.length === 0) break;

        for (const item of list) {
          const txHash = String(item?.tx_hash || "");
          if (!txHash) continue;

          // block_time
          const tx = await adaGET<any>(`/txs/${txHash}`);
          const block_time = Number(tx?.block_time || Date.now());
          const whenISO = new Date(block_time * 1000).toISOString();

          // outputs za našu adresu
          const utxos = await adaGET<any>(`/txs/${txHash}/utxos`);
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

    // 4) De-dup by (tx_hash, wallet_id)
    let existing = new Set<string>();
    if (rows.length) {
      const uniqHashes = Array.from(new Set(rows.map((r) => r.tx_hash)));
      const { data: ex } = await sb
        .from("contributions")
        .select("tx_hash, wallet_id")
        .in("tx_hash", uniqHashes);
      existing = new Set((ex || []).map((e: any) => `${e.tx_hash}:${e.wallet_id}`));
    }
    const toInsert = rows.filter((r) => !existing.has(`${r.tx_hash}:${r.wallet_id}`));

    if (toInsert.length) {
      const { error: insErr } = await sb.from("contributions").insert(toInsert);
      if (insErr) throw insErr;
    }

    // 5) spremi cursor
    await sb
      .from("settings")
      .upsert({ key: CUR, value: { n: to }, updated_at: new Date().toISOString() });

    return ok({
      latest,
      from,
      to,
      scanned,
      candidates: rows.length,
      inserted: toInsert.length,
      base: adaBase(),
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

