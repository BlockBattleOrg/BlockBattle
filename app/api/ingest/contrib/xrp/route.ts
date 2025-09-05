// app/api/ingest/contrib/xrp/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Keep Node.js runtime for fetch/AbortController and non-edge compat
export const runtime = "nodejs";

/**
 * XRP (Ripple) native contributions ingest (account-based).
 * - Scans validated ledgers and picks Payment txs to our funding accounts (Destination).
 * - Writes into `public.contributions` (wallet_id, tx_hash, amount, block_time).
 * - Cursor (last scanned ledger) is stored in `public.settings` under `xrp_contrib_last_scanned`.
 *
 * ENV required:
 *  - CRON_SECRET
 *  - NEXT_PUBLIC_SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *
 * Preferred RPC (NowNodes-compatible rippled):
 *  - XRP_RPC_POOL   (optional, comma/newline-separated list of base URLs)
 *  - XRP_RPC_URL    (fallback single base, e.g. https://xrp.nownodes.io)
 *  - NOWNODES_API_KEY (optional; multiple header/query variants attempted)
 *
 * Query params:
 *  - tx=<hash>                        // force single tx ingest path
 *  - sinceLedger=<index>              // start from ledger index
 *  - sinceHours=<n>                   // approximate backoff by time
 *  - overlap=<n=200>                  // re-scan this many ledgers before cursor
 *  - maxLedgers=<n=4000>              // hard limit per run
 *  - minConf=<n=2>                    // # of ledgers behind validated tip
 *  - debug=1                          // include rich debug info
 *
 * IMPORTANT:
 *  - We DO NOT write amount_usd here. Pricing is handled elsewhere.
 */

// ---------- Tunables & helpers ----------
const DECIMALS = 6;              // 1 XRP = 1,000,000 drops
const AVG_LEDGER_SEC = 4;        // avg close time; used only for sinceHours backoff
const DEFAULT_MAX_LEDGERS = 4000;
const DEFAULT_MIN_CONF = 2;
const DEFAULT_OVERLAP = 200;
const DEFAULT_BATCH_FALLBACK = 2000; // conservative first run

const CURSOR_KEY = "xrp_contrib_last_scanned";

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

// Canonical chain normalizer (shared semantics across routes).
function canonChain(x: string | null | undefined): string {
  const v = (x || "").toLowerCase();
  if (v.includes("bitcoin") || v === "btc") return "BTC";
  if (v.includes("litecoin") || v === "ltc") return "LTC";
  if (v.includes("doge")) return "DOGE";
  if (v.includes("xrp") || v.includes("ripple")) return "XRP";
  if (v.includes("xlm") || v.includes("stellar")) return "XLM";
  if (v.includes("sol") || v.includes("solana")) return "SOL";
  if (v.includes("trx") || v.includes("tron")) return "TRX";
  if (v.includes("dot") || v.includes("polkadot")) return "DOT";
  if (v.includes("atom") || v.includes("cosmos")) return "ATOM";
  if (v.includes("bsc") || v.includes("bnb")) return "BNB";
  if (v.includes("eth")) return "ETH";
  return v.toUpperCase();
}

// ---------- RPC pool & NowNodes auth fallbacks ----------
function parsePool(envPool?: string, envSingle?: string) {
  const list: string[] = [];
  const push = (s?: string) => {
    if (!s) return;
    const t = s.trim().replace(/\/+$/, "");
    if (t) list.push(t);
  };

  if (envPool) for (const part of envPool.split(/[\n,]+/)) push(part);
  push(envSingle);

  // Optional public fallback if provided by user
  if (process.env.XRP_PUBLIC_RPC_URL) push(process.env.XRP_PUBLIC_RPC_URL);

  return Array.from(new Set(list));
}

type RpcAttempt = {
  url: string;
  headers: Record<string, string>;
  headerTip: string;
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
  } else {
    attempts.push({ url: clean, headers: baseHeaders, headerTip: "no-key" });
  }
  return attempts;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function xrpRpc<T = any>(
  method: string,
  params: any,
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
          body: JSON.stringify({ method, params: [params] }),
          signal: controller.signal,
        });
        const j = await res.json().catch(() => ({}));
        clearTimeout(timer);

        const r = j?.result || j; // some gateways wrap under .result
        if (res.ok && !r?.error) {
          if (debugLog) debugLog.push(`RPC OK via ${att.url} [${att.headerTip}]`);
          return { result: r as T, used: { url: att.url, headerTip: att.headerTip } };
        }
        lastErr = new Error(`RPC ${res.status} ${JSON.stringify(r?.error || {})} @ ${att.url} [${att.headerTip}]`);
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
    const { result, used } = await xrpRpc<T>(method, params, pool, apiKey, { retries: 0, timeoutMs, debugLog });
    return { result, used };
  }

  throw lastErr || new Error("All RPC attempts failed");
}

// ---------- Amount helpers ----------
/** Amount can be:
 *  - string (drops)  => native XRP
 *  - object { currency, issuer, value } => issued assets (IOUs) -> ignore
 */
function asXrpAmount(amount: any): number | null {
  if (amount == null) return null;
  if (typeof amount === "string") {
    // drops -> XRP
    const drops = BigInt(amount);
    return Number(drops) / 10 ** DECIMALS;
  }
  return null;
}

// Ripple epoch (2000-01-01) to UNIX epoch
function rippleEpochToUnix(epochSeconds: number): number {
  // Ripple epoch starts at 2000-01-01T00:00:00Z, which is Unix 946684800
  return epochSeconds + 946684800;
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

    // Load wallets and filter to XRP via canonChain
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true);
    if (wErr) throw wErr;

    const funding = (wallets || [])
      .filter(w => canonChain(String(w.chain)) === "XRP")
      .map(w => ({ id: String(w.id), addr: String((w as any).address || "").trim() }))
      .filter(w => !!w.addr);

    if (!funding.length) {
      return ok({ note: "No active XRP wallets", inserted: 0, scanned: 0 });
    }

    const addrSet = new Set(funding.map(f => f.addr));
    const addrToWallet = new Map(funding.map(f => [f.addr, f.id]));

    // RPC pool
    const pool = parsePool(process.env.XRP_RPC_POOL, process.env.XRP_RPC_URL || "https://xrp.nownodes.io");
    const apiKey = process.env.NOWNODES_API_KEY || null;

    // Parse query
    const url = new URL(req.url);
    const qp = url.searchParams;
    const forceTx = qp.get("tx") || "";
    const sinceLedger = Number(qp.get("sinceLedger") || "0");
    const sinceHours = Number(qp.get("sinceHours") || "0");
    const overlap = Number(qp.get("overlap") || String(DEFAULT_OVERLAP));
    const maxLedgers = Number(qp.get("maxLedgers") || String(DEFAULT_MAX_LEDGERS));
    const minConf = Math.max(0, Number(qp.get("minConf") || String(DEFAULT_MIN_CONF)));
    const richDebug = qp.get("debug") === "1";

    // Get validated tip
    const tipWrap = await xrpRpc<any>("ledger", { ledger_index: "validated" }, pool, apiKey, { debugLog: dbg });
    const tipLedger = Number(tipWrap.result?.ledger_index ?? tipWrap.result?.ledger?.ledger_index ?? 0);
    const safeTip = Math.max(0, tipLedger - minConf);

    // Force single tx mode
    if (forceTx) {
      const txRes = await xrpRpc<any>("tx", { transaction: forceTx, binary: false }, pool, apiKey, { debugLog: dbg });
      const tx = txRes.result;
      if (!tx || !tx.hash) return err("Transaction not found", 404, { tx: forceTx });

      if (tx.TransactionType !== "Payment") {
        return ok({ note: "Not a Payment transaction", tx: tx.hash, inserted: 0 });
      }

      const dest = String(tx.Destination || "");
      if (!addrSet.has(dest)) {
        return ok({ note: "Tx not to a funding address", tx: tx.hash, destination: dest, inserted: 0 });
      }

      // Time
      // Prefer `date` field (Ripple epoch seconds), fallback to ledger close time via ledger hash
      let whenISO = new Date().toISOString();
      if (typeof tx.date === "number") {
        const unix = rippleEpochToUnix(tx.date);
        whenISO = new Date(unix * 1000).toISOString();
      } else if (tx.ledger_index) {
        const l = await xrpRpc<any>("ledger", { ledger_index: tx.ledger_index }, pool, apiKey, { debugLog: dbg });
        const close = Number(l.result?.ledger?.close_time || 0);
        if (close) whenISO = new Date(rippleEpochToUnix(close) * 1000).toISOString();
      }

      // Amount (only native XRP)
      const delivered = tx.meta?.delivered_amount ?? tx.DeliveredAmount ?? tx.Amount;
      const amount = asXrpAmount(delivered);
      if (amount == null) {
        return ok({ note: "Payment in issued asset (non-XRP) – ignored", tx: tx.hash, inserted: 0 });
      }

      const wallet_id = addrToWallet.get(dest)!;
      const { error: iErr } = await sb
        .from("contributions")
        .upsert([{ wallet_id, tx_hash: tx.hash, amount, block_time: whenISO }], { onConflict: "tx_hash" })
        .select("tx_hash");
      if (iErr) throw iErr;

      // Move cursor to at least this ledger
      if (tx.ledger_index) {
        await sb.from("settings").upsert({ key: CURSOR_KEY, value: { n: Number(tx.ledger_index) } }, { onConflict: "key" });
      }

      const resBody: Json = {
        chain: "xrp",
        mode: "forceTx",
        tipLedger,
        safeTip,
        tx: tx.hash,
        destination: dest,
        inserted: 1,
      };
      if (richDebug) resBody.debugLog = dbg;
      return ok(resBody);
    }

    // Determine range
    const { data: st } = await sb.from("settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
    const prev = Number(st?.value?.n ?? 0);

    let from: number;
    let reason = "";

    if (sinceLedger > 0) {
      from = sinceLedger;
      reason = "sinceLedger";
    } else if (sinceHours > 0) {
      const approxLedgers = Math.floor((sinceHours * 3600) / AVG_LEDGER_SEC);
      from = Math.max(0, safeTip - approxLedgers);
      reason = "sinceHours";
    } else if (prev > 0) {
      from = Math.max(0, prev - overlap + 1);
      reason = "marker/overlap";
    } else {
      from = Math.max(0, safeTip - Math.min(DEFAULT_BATCH_FALLBACK, maxLedgers) + 1);
      reason = "fallback";
    }

    let to = Math.min(safeTip, from + Math.max(1, maxLedgers) - 1);
    if (to < from) {
      const body: Json = { tipLedger, safeTip, from, to, scanned: 0, inserted: 0, note: "Nothing to scan (waiting for validations)" };
      if (richDebug) {
        body.debugLog = dbg;
      }
      return ok(body);
    }

    // Scan ledgers
    let scanned = 0;
    const rows: Array<{ wallet_id: string; tx_hash: string; amount: number; block_time: string }> = [];

    for (let li = from; li <= to; li++) {
      const led = await xrpRpc<any>(
        "ledger",
        { ledger_index: li, transactions: true, expand: true },
        pool,
        apiKey,
        { debugLog: dbg }
      );
      scanned++;

      const closeRipple = Number(led.result?.ledger?.close_time || 0);
      const closeISO = closeRipple ? new Date(rippleEpochToUnix(closeRipple) * 1000).toISOString() : new Date().toISOString();

      const txs: any[] = Array.isArray(led.result?.ledger?.transactions) ? led.result.ledger.transactions : [];
      for (const tx of txs) {
        try {
          if (tx?.TransactionType !== "Payment") continue;

          const dest = String(tx?.Destination || "");
          if (!addrSet.has(dest)) continue;

          const delivered = tx?.meta?.delivered_amount ?? tx?.DeliveredAmount ?? tx?.Amount;
          const amount = asXrpAmount(delivered);
          if (amount == null || amount <= 0) continue;

          const wallet_id = addrToWallet.get(dest)!;
          const txHash = String(tx?.hash || "");
          if (!txHash) continue;

          rows.push({ wallet_id, tx_hash: txHash, amount, block_time: closeISO });
        } catch (_) {
          // ignore malformed tx entries
        }
      }
    }

    // Upsert all matches (idempotent on tx_hash)
    let inserted = 0;
    if (rows.length) {
      const { data: upserted, error: iErr } = await sb
        .from("contributions")
        .upsert(rows, { onConflict: "tx_hash" })
        .select("tx_hash");
      if (iErr) throw iErr;
      inserted = upserted?.length || 0;
    }

    // Move cursor forward
    await sb.from("settings").upsert({ key: CURSOR_KEY, value: { n: to } }, { onConflict: "key" });

    const res: Json = {
      ok: true,
      chain: "xrp",
      reason,
      tipLedger,
      safeTip,
      from,
      to,
      scanned,
      matched: rows.length,
      inserted,
    };
    if (richDebug) res.debugLog = dbg;
    return NextResponse.json(res);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const body: Json = { ok: false, error: msg };
    return NextResponse.json(body, { status: 500 });
  }
}

