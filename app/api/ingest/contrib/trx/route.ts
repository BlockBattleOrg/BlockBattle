// app/api/ingest/contrib/trx/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type Json = Record<string, any>;

function bad(msg: string, code = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status: code });
}
function ok(body: Json = {}) {
  return NextResponse.json({ ok: true, ...body });
}

function env(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return v;
}

function supa() {
  const url = env("NEXT_PUBLIC_SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

// --- Tron RPC helper (NowNodes -> Tron FullNode REST) ---
async function trxRpc<T = any>(
  path: string,
  body: any = {},
  visible = true
): Promise<T> {
  const base = env("TRX_RPC_URL").replace(/\/+$/, "");
  const key = env("NOWNODES_API_KEY");
  const url = `${base}${path}${visible ? "?visible=true" : ""}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": key,
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`TRX HTTP ${res.status} ${txt}`);
  }
  return (await res.json()) as T;
}

const DECIMALS = 6; // TRX = SUN/1e6

export async function POST(req: Request) {
  try {
    // --- auth (cron) ---
    const want = env("CRON_SECRET");
    const got = req.headers.get("x-cron-secret") || "";
    if (got !== want) return bad("Unauthorized", 401);

    // --- env guard for TRX ---
    env("TRX_RPC_URL");
    env("NOWNODES_API_KEY");

    const sb = supa();

    // --- active wallets for TRON ---
    // Chain naming u bazi: "tron" (prema tvojim screenshotovima)
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true)
      .eq("chain", "tron");

    if (wErr) throw wErr;
    const active = (wallets || []).filter(
      (w) => w.address && typeof w.address === "string"
    );

    if (active.length === 0) {
      return ok({ scanned: 0, inserted: 0, note: "No active TRON wallets" });
    }

    // Map adresa -> wallet_id (base58 'T...' očekujemo jer koristimo ?visible=true)
    const addr2wallet = new Map<string, string>();
    for (const w of active) addr2wallet.set(String(w.address), String(w.id));

    // --- load last scanned height ---
    const SET_KEY = "trx_contrib_last_scanned";
    const { data: st } = await sb
      .from("settings")
      .select("value")
      .eq("key", SET_KEY)
      .maybeSingle();

    let last = Number(st?.value?.n ?? 0);

    // --- latest block ---
    const nowBlock = await trxRpc<any>("/wallet/getnowblock", {});
    const latest =
      Number(
        nowBlock?.block_header?.raw_data?.number ??
          nowBlock?.blockID /* fallback, though number is standard */
      ) || 0;

    if (!latest) return bad("TRX: failed to resolve latest block");

    // init last if empty (prvi run): skeniraj samo malo unatrag
    if (!last || last <= 0) last = Math.max(0, latest - 2000);

    const SPAN = Number(process.env.TRX_BLOCK_SPAN || "500");
    const from = last + 1;
    const to = Math.min(latest, last + SPAN);

    if (to < from) {
      // ništa novo
      return ok({ latest, from: last, to: last, scanned: 0, inserted: 0 });
    }

    // --- scan blocks [from..to] ---
    let inserted = 0;
    let scanned = 0;
    const rows: Array<{
      wallet_id: string;
      tx_hash: string;
      amount: number;
      amount_usd: number | null;
      block_time: string;
    }> = [];

    for (let h = from; h <= to; h++) {
      scanned++;
      const blk = await trxRpc<any>("/wallet/getblockbynum", { num: h });

      const bts =
        Number(blk?.block_header?.raw_data?.timestamp) ||
        Number(blk?.timestamp) ||
        Date.now();

      const txs: any[] = blk?.transactions || [];
      if (!txs.length) continue;

      for (const tx of txs) {
        const contracts: any[] = tx?.raw_data?.contract || [];
        if (!contracts.length) continue;

        // status OK?
        const status =
          tx?.ret?.[0]?.contractRet ||
          tx?.ret?.[0]?.ret ||
          tx?.receipt?.result ||
          "SUCCESS";
        if (String(status) !== "SUCCESS") continue;

        for (const c of contracts) {
          if (c?.type !== "TransferContract") continue;

          const v = c?.parameter?.value || {};
          const toAddr = String(v?.to_address || "");
          const amountSun = Number(v?.amount || 0);

          if (!toAddr || !amountSun) continue;

          const walletId = addr2wallet.get(toAddr);
          if (!walletId) continue;

          const amount = amountSun / 10 ** DECIMALS;
          const when =
            Number(tx?.raw_data?.timestamp) || Number(bts) || Date.now();

          rows.push({
            wallet_id: walletId,
            tx_hash: String(tx?.txID || tx?.txid || ""),
            amount,
            amount_usd: null,
            block_time: new Date(when).toISOString(),
          });
        }
      }
    }

    if (rows.length) {
      const { error: insErr } = await sb.from("contributions").insert(rows);
      if (insErr) throw insErr;
      inserted = rows.length;
    }

    // --- save cursor ---
    await sb
      .from("settings")
      .upsert({ key: SET_KEY, value: { n: to }, updated_at: new Date().toISOString() });

    return ok({ latest, from, to, scanned, inserted });
  } catch (e: any) {
    return bad(e?.message || String(e), 500);
  }
}

