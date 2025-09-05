// app/api/ingest/contrib/sol/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Keep Node.js runtime (non-edge)
export const runtime = "nodejs";

/**
 * SOL (Solana) native contributions ingest.
 * - Skenira slotove (blokove) i pronalazi SystemProgram transfer u naše funding adrese.
 * - Piše u `public.contributions` (wallet_id, tx_hash, amount, block_time).
 * - Marker (zadnji obrađeni slot) je u `public.settings` pod ključem `sol_contrib_last_scanned`.
 *
 * ENV:
 *  - CRON_SECRET
 *  - NEXT_PUBLIC_SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *
 * RPC (NowNodes / kompatibilan Solana JSON-RPC):
 *  - SOL_RPC_POOL   (opcionalno; lista baza, comma/newline-separated)
 *  - SOL_RPC_URL    (fallback single base, npr. https://sol.nownodes.io)
 *  - NOWNODES_API_KEY (opcionalno; pokušavamo više header/query varijanti)
 *
 * Query:
 *  - tx=<sig>                     // forsiraj single-tx ingest
 *  - sinceSlot=<n>                // početni slot
 *  - sinceHours=<n>               // vremenski backoff (≈ 0.4s po slotu)
 *  - overlap=<n=400>              // preskeniraj ovoliko prije markera
 *  - maxSlots=<n=4000>            // limit po runu
 *  - minConf=<n=64>               // “finality gap” (tip - minConf)
 *  - debug=1                      // bogat debug
 *
 * Napomena:
 *  - Ne pišemo amount_usd ovdje (radi se drugdje).
 */

// ---------- Tunables & helpers ----------
const DECIMALS = 9;            // 1 SOL = 1e9 lamports
const AVG_SLOT_SEC = 0.4;      // gruba aproksimacija za sinceHours
const DEFAULT_MAX_SLOTS = 4000;
const DEFAULT_MIN_CONF = 64;
const DEFAULT_OVERLAP = 400;
const DEFAULT_BATCH_FALLBACK = 2000;

const CURSOR_KEY = "sol_contrib_last_scanned";

type Json = Record<string, any>;
const ok = (b: Json = {}) => NextResponse.json({ ok: true, ...b });
const err = (m: string, status = 500, extra?: Json) =>
  NextResponse.json({ ok: false, error: m, ...(extra || {}) }, { status });

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

// Canonical chain (isti obrazac kao i ostale rute)
function canonChain(x: string | null | undefined): string {
  const v = (x || "").toLowerCase();
  if (v.includes("sol")) return "SOL";
  if (v.includes("trx") || v.includes("tron")) return "TRX";
  if (v.includes("dot") || v.includes("polkadot")) return "DOT";
  if (v.includes("atom") || v.includes("cosmos")) return "ATOM";
  // ostalo…
  return v.toUpperCase();
}

// ---------- RPC pool & auth fallbacks ----------
function parsePool(envPool?: string, envSingle?: string) {
  const list: string[] = [];
  const push = (s?: string) => {
    if (!s) return;
    const t = s.trim().replace(/\/+$/, "");
    if (t) list.push(t);
  };
  if (envPool) for (const part of envPool.split(/[\n,]+/)) push(part);
  push(envSingle);
  if (process.env.SOL_PUBLIC_RPC_URL) push(process.env.SOL_PUBLIC_RPC_URL);
  return Array.from(new Set(list));
}

type RpcAttempt = {
  url: string;
  headers: Record<string, string>;
  headerTip: string;
  queryKey?: string;
};

function buildRpcAttempts(base: string, apiKey?: string | null): RpcAttempt[] {
  const attempts: RpcAttempt[] = [];
  const clean = base.replace(/\/+$/, "");
  const baseHeaders: Record<string, string> = { "Content-Type": "application/json" };

  if (apiKey && apiKey.trim()) {
    const k = apiKey.trim();
    attempts.push({ url: clean, headers: { ...baseHeaders, "api-key": k }, headerTip: "api-key" });
    attempts.push({ url: clean, headers: { ...baseHeaders, "x-api-key": k }, headerTip: "x-api-key" });
    attempts.push({ url: clean, headers: { ...baseHeaders, "X-API-KEY": k }, headerTip: "X-API-KEY" });
    attempts.push({ url: clean, headers: { ...baseHeaders, Authorization: `Bearer ${k}` }, headerTip: "Bearer" });
    // Neki gateway-i očekuju query ključ
    attempts.push({ url: `${clean}?apikey=${encodeURIComponent(k)}`, headers: baseHeaders, headerTip: "query:apikey", queryKey: "apikey" });
    attempts.push({ url: `${clean}?api_key=${encodeURIComponent(k)}`, headers: baseHeaders, headerTip: "query:api_key", queryKey: "api_key" });
    attempts.push({ url: `${clean}?apiKey=${encodeURIComponent(k)}`, headers: baseHeaders, headerTip: "query:apiKey", queryKey: "apiKey" });
  } else {
    attempts.push({ url: clean, headers: baseHeaders, headerTip: "no-key" });
  }
  return attempts;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function solRpc<T = any>(
  method: string,
  params: any[],
  pool: string[],
  apiKey?: string | null,
  opts?: { retries?: number; timeoutMs?: number; debugLog?: string[] }
): Promise<{ result: T; used: { url: string; headerTip: string } }> {
  const retries = opts?.retries ?? 2;
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const debugLog = opts?.debugLog;
  let lastErr: any = null;

  for (const base of pool) {
    for (const att of buildRpcAttempts(base, apiKey)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(att.url, {
          method: "POST",
          headers: att.headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          signal: controller.signal,
        });
        const j = await res.json().catch(() => ({}));
        clearTimeout(timer);
        if (res.ok && !j?.error) {
          if (debugLog) debugLog.push(`RPC OK via ${att.url} [${att.headerTip}]`);
          return { result: (j.result ?? j) as T, used: { url: att.url, headerTip: att.headerTip } };
        }
        lastErr = new Error(`RPC ${res.status} ${JSON.stringify(j?.error || {})} @ ${att.url} [${att.headerTip}]`);
        if (debugLog) debugLog.push(String(lastErr));
      } catch (e: any) {
        clearTimeout(timer);
        lastErr = e;
        if (debugLog) debugLog.push(`RPC error: ${(e?.message || e)} @ ${att.url} [${att.headerTip}]`);
      }
      await sleep(200);
    }
  }

  for (let i = 0; i < retries; i++) {
    await sleep(400 * (i + 1));
    const { result, used } = await solRpc<T>(method, params, pool, apiKey, { retries: 0, timeoutMs, debugLog });
    return { result, used };
  }
  throw lastErr || new Error("All RPC attempts failed");
}

// ---------- Amount/helper utils ----------
const lamportsToSol = (lamports: number | bigint) => Number(lamports) / 10 ** DECIMALS;

// Pomoćna: izvući SOL transfere iz jsonParsed instrukcija
function extractSolTransfersFromTx(tx: any): Array<{ destination: string; lamports: number }> {
  try {
    const msg = tx?.transaction?.message;
    const ix = Array.isArray(msg?.instructions) ? msg.instructions : [];
    const res: Array<{ destination: string; lamports: number }> = [];
    for (const i of ix) {
      const parsed = i?.parsed;
      if (!parsed) continue;
      const typ = parsed?.type || parsed?.info?.type;
      const prog = i?.program || parsed?.program;
      if ((prog === "system" || prog === "spl-system") && typ === "transfer") {
        const info = parsed?.info || {};
        const dest = String(info?.destination || "");
        const lam = Number(info?.lamports ?? 0);
        if (dest && lam > 0) res.push({ destination: dest, lamports: lam });
      }
    }
    // innerInstructions (ako postoje)
    const metaInner = tx?.meta?.innerInstructions;
    if (Array.isArray(metaInner)) {
      for (const inner of metaInner) {
        const arr = Array.isArray(inner?.instructions) ? inner.instructions : [];
        for (const i of arr) {
          const parsed = i?.parsed;
          if (!parsed) continue;
          const typ = parsed?.type || parsed?.info?.type;
          const prog = i?.program || parsed?.program;
          if ((prog === "system" || prog === "spl-system") && typ === "transfer") {
            const info = parsed?.info || {};
            const dest = String(info?.destination || "");
            const lam = Number(info?.lamports ?? 0);
            if (dest && lam > 0) res.push({ destination: dest, lamports: lam });
          }
        }
      }
    }
    return res;
  } catch {
    return [];
  }
}

// ---------- Main handler ----------
export async function POST(req: Request) {
  const dbg: string[] = [];
  try {
    // Auth
    const expected = need("CRON_SECRET");
    if ((req.headers.get("x-cron-secret") || "") !== expected) {
      return err("Unauthorized", 401);
    }

    const sb = supa();

    // Wallets -> samo SOL
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true);
    if (wErr) throw wErr;

    const funding = (wallets || [])
      .filter(w => canonChain(String(w.chain)) === "SOL")
      .map(w => ({ id: String(w.id), addr: String((w as any).address || "").trim() }))
      .filter(w => !!w.addr);

    if (!funding.length) return ok({ note: "No active SOL wallets", inserted: 0, scanned: 0 });

    const addrSet = new Set(funding.map(f => f.addr));
    const addrToWallet = new Map(funding.map(f => [f.addr, f.id]));

    // RPC pool
    const pool = parsePool(process.env.SOL_RPC_POOL, process.env.SOL_RPC_URL || "https://sol.nownodes.io");
    const apiKey = process.env.NOWNODES_API_KEY || null;

    // Query
    const url = new URL(req.url);
    const qp = url.searchParams;
    const forceTx = qp.get("tx") || "";          // signature
    const sinceSlot = Number(qp.get("sinceSlot") || "0");
    const sinceHours = Number(qp.get("sinceHours") || "0");
    const overlap = Number(qp.get("overlap") || String(DEFAULT_OVERLAP));
    const maxSlots = Number(qp.get("maxSlots") || String(DEFAULT_MAX_SLOTS));
    const minConf = Math.max(0, Number(qp.get("minConf") || String(DEFAULT_MIN_CONF)));
    const richDebug = qp.get("debug") === "1";

    // Tip & safe head (finalized)
    const tipSlotWrap = await solRpc<number>("getSlot", [{ commitment: "finalized" }], pool, apiKey, { debugLog: dbg });
    const tip = Number(tipSlotWrap.result || 0);
    const safeTip = Math.max(0, tip - minConf);

    // Force tx (signature) path
    if (forceTx) {
      // getTransaction(signature, {encoding:"jsonParsed"})
      const txWrap = await solRpc<any>(
        "getTransaction",
        [forceTx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 } as any],
        pool,
        apiKey,
        { debugLog: dbg }
      );
      const tx = txWrap.result;
      if (!tx) return err("Transaction not found", 404, { tx: forceTx });

      const transfers = extractSolTransfersFromTx(tx);
      const matches = transfers.filter(t => addrSet.has(t.destination));
      if (!matches.length) return ok({ note: "No SOL transfers to funding addresses", tx: forceTx, inserted: 0 });

      const whenISO = tx?.blockTime ? new Date(Number(tx.blockTime) * 1000).toISOString() : new Date().toISOString();

      let inserted = 0;
      for (const m of matches) {
        const wallet_id = addrToWallet.get(m.destination)!;
        const amount = lamportsToSol(m.lamports);
        const { error: iErr } = await sb
          .from("contributions")
          .upsert([{ wallet_id, tx_hash: forceTx, amount, block_time: whenISO }], { onConflict: "tx_hash" })
          .select("tx_hash");
        if (iErr) throw iErr;
        inserted += 1;
      }

      const res: Json = { chain: "sol", mode: "forceTx", tip, safeTip, tx: forceTx, outputsMatched: matches.length, inserted };
      if (richDebug) (res as any).debugLog = dbg;
      return ok(res);
    }

    // Marker iz settings
    const { data: st } = await sb.from("settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
    const prev = Number(st?.value?.n ?? 0);

    // Odredi range
    let from: number;
    let reason = "";
    if (sinceSlot > 0) {
      from = sinceSlot;
      reason = "sinceSlot";
    } else if (sinceHours > 0) {
      const approxSlots = Math.max(1, Math.floor((sinceHours * 3600) / AVG_SLOT_SEC));
      from = Math.max(0, safeTip - approxSlots);
      reason = "sinceHours";
    } else if (prev > 0) {
      from = Math.max(0, prev - overlap + 1);
      reason = "marker/overlap";
    } else {
      from = Math.max(0, safeTip - Math.min(DEFAULT_BATCH_FALLBACK, maxSlots) + 1);
      reason = "fallback";
    }

    let to = Math.min(safeTip, from + Math.max(1, maxSlots) - 1);
    if (to < from) {
      const body: Json = { tip, safeTip, from, to, scanned: 0, inserted: 0, note: "Nothing to scan (waiting for finalization)" };
      if (richDebug) (body as any).debugLog = dbg;
      return ok(body);
    }

    // Scan slot-by-slot (getBlock with jsonParsed)
    let scanned = 0;
    const rows: Array<{ wallet_id: string; tx_hash: string; amount: number; block_time: string }> = [];

    for (let s = from; s <= to; s++) {
      // getBlock(s, {…})
      const blkWrap = await solRpc<any>(
        "getBlock",
        [s, { encoding: "jsonParsed", transactionDetails: "full", rewards: false, maxSupportedTransactionVersion: 0 } as any],
        pool,
        apiKey,
        { debugLog: dbg }
      );
      scanned++;

      const blk = blkWrap.result;
      if (!blk) continue;

      const whenISO = blk?.blockTime ? new Date(Number(blk.blockTime) * 1000).toISOString() : new Date().toISOString();
      const txs: any[] = Array.isArray(blk?.transactions) ? blk.transactions : [];

      for (const tx of txs) {
        const transfers = extractSolTransfersFromTx(tx);
        if (!transfers.length) continue;

        const sig = String(tx?.transaction?.signatures?.[0] || "");
        if (!sig) continue;

        for (const t of transfers) {
          if (!addrSet.has(t.destination)) continue;
          const wallet_id = addrToWallet.get(t.destination)!;
          const amount = lamportsToSol(t.lamports);
          rows.push({ wallet_id, tx_hash: sig, amount, block_time: whenISO });
        }
      }
    }

    // Upsert
    let inserted = 0;
    if (rows.length) {
      const { data: upserted, error: iErr } = await sb
        .from("contributions")
        .upsert(rows, { onConflict: "tx_hash" })
        .select("tx_hash");
      if (iErr) throw iErr;
      inserted = upserted?.length || 0;
    }

    // Pomakni marker
    await sb.from("settings").upsert({ key: CURSOR_KEY, value: { n: to } }, { onConflict: "key" });

    const res: Json = {
      ok: true,
      chain: "sol",
      reason,
      tip,
      safeTip,
      from,
      to,
      scanned,
      matched: rows.length,
      inserted,
    };
    if (richDebug) (res as any).debugLog = dbg;
    return NextResponse.json(res);
  } catch (e: any) {
    const msg = String(e?.message || e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

