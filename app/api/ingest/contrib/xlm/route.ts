// app/api/ingest/contrib/xlm/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Keep Node.js runtime (AbortController, fetch timeouts)
export const runtime = "nodejs";

/**
 * XLM (Stellar) native contributions ingest (account-based via Horizon).
 * - Scans ledgers and picks Payment operations (asset_type=native) whose `to` matches our funding accounts.
 * - Writes into `public.contributions` (wallet_id, tx_hash, amount, block_time).
 * - Cursor (last scanned ledger) lives in `public.settings` under `xlm_contrib_last_scanned`.
 *
 * ENV required:
 *  - CRON_SECRET
 *  - NEXT_PUBLIC_SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *
 * Preferred Horizon endpoints (NowNodes or compatible):
 *  - XLM_RPC_POOL   (optional, comma/newline-separated list of base URLs, e.g. https://xlm.nownodes.io)
 *  - XLM_RPC_URL    (fallback single base)
 *  - NOWNODES_API_KEY (optional; multiple header/query variants attempted)
 *
 * Query params:
 *  - tx=<hash>                        // force single transaction ingest
 *  - sinceLedger=<n>                  // start from ledger sequence
 *  - sinceHours=<n>                   // approximate backoff by time
 *  - overlap=<n=200>                  // re-scan this many ledgers before cursor
 *  - maxLedgers=<n=4000>              // hard limit per run
 *  - minConf=<n=2>                    // confirmations (ledgers behind tip)
 *  - debug=1                          // include rich debug info
 *
 * IMPORTANT:
 *  - We DO NOT write amount_usd here. Pricing is handled elsewhere.
 */

// ---------- Tunables & helpers ----------
const DECIMALS = 7;                 // 1 XLM = 10^7 stroops
const AVG_LEDGER_SEC = 5;           // used only for sinceHours backoff
const DEFAULT_MAX_LEDGERS = 4000;
const DEFAULT_MIN_CONF = 2;
const DEFAULT_OVERLAP = 200;
const DEFAULT_BATCH_FALLBACK = 2000; // conservative initial window

const CURSOR_KEY = "xlm_contrib_last_scanned";

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

// Canonical chain
function canonChain(x: string | null | undefined): string {
  const v = (x || "").toLowerCase();
  if (v.includes("xlm") || v.includes("stellar")) return "XLM";
  if (v.includes("xrp") || v.includes("ripple")) return "XRP";
  if (v.includes("sol")) return "SOL";
  if (v.includes("trx") || v.includes("tron")) return "TRX";
  if (v.includes("dot") || v.includes("polkadot")) return "DOT";
  if (v.includes("atom") || v.includes("cosmos")) return "ATOM";
  if (v.includes("btc") || v.includes("bitcoin")) return "BTC";
  if (v.includes("ltc") || v.includes("litecoin")) return "LTC";
  if (v.includes("doge")) return "DOGE";
  return v.toUpperCase();
}

// ---------- Horizon pool & auth fallbacks ----------
function parsePool(envPool?: string, envSingle?: string) {
  const list: string[] = [];
  const push = (s?: string) => {
    if (!s) return;
    const t = s.trim().replace(/\/+$/, "");
    if (t) list.push(t);
  };
  if (envPool) for (const part of envPool.split(/[\n,]+/)) push(part);
  push(envSingle);
  if (process.env.XLM_PUBLIC_RPC_URL) push(process.env.XLM_PUBLIC_RPC_URL);
  return Array.from(new Set(list));
}

type HttpAttempt = { url: string; headers: Record<string, string>; queryKey?: string; headerTip: string };

function buildHttpAttempts(base: string, apiKey?: string | null): HttpAttempt[] {
  const clean = base.replace(/\/+$/, "");
  const baseHeaders: Record<string, string> = { "Content-Type": "application/json" };
  const attempts: HttpAttempt[] = [];

  if (apiKey && apiKey.trim()) {
    const k = apiKey.trim();
    attempts.push({ url: clean, headers: { ...baseHeaders, "api-key": k }, headerTip: "api-key" });
    attempts.push({ url: clean, headers: { ...baseHeaders, "x-api-key": k }, headerTip: "x-api-key" });
    attempts.push({ url: clean, headers: { ...baseHeaders, "X-API-KEY": k }, headerTip: "X-API-KEY" });
    attempts.push({ url: clean, headers: { ...baseHeaders, Authorization: `Bearer ${k}` }, headerTip: "Bearer" });
    // Query-key variants (some gateways expect it)
    attempts.push({ url: clean, headers: baseHeaders, queryKey: "apikey", headerTip: "query:apikey" });
    attempts.push({ url: clean, headers: baseHeaders, queryKey: "api_key", headerTip: "query:api_key" });
    attempts.push({ url: clean, headers: baseHeaders, queryKey: "apiKey", headerTip: "query:apiKey" });
  } else {
    attempts.push({ url: clean, headers: baseHeaders, headerTip: "no-key" });
  }
  return attempts;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function horizonGet<T = any>(
  path: string,
  query: Record<string, string | number | undefined>,
  pool: string[],
  apiKey?: string | null,
  opts?: { retries?: number; timeoutMs?: number; debugLog?: string[] }
): Promise<{ json: T; used: { url: string; headerTip: string } }> {
  const retries = opts?.retries ?? 2;
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const debugLog = opts?.debugLog;
  let lastErr: any = null;

  for (const base of pool) {
    for (const att of buildHttpAttempts(base, apiKey)) {
      const u = new URL(att.url + path);
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
      if (att.queryKey) u.searchParams.set(att.queryKey, String(apiKey));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(u.toString(), { method: "GET", headers: att.headers, signal: controller.signal });
        const j = await res.json().catch(() => ({}));
        clearTimeout(timer);
        if (res.ok && !(j as any)?.status) {
          if (debugLog) debugLog.push(`Horizon OK ${u.pathname} via ${att.url} [${att.headerTip}]`);
          return { json: j as T, used: { url: att.url, headerTip: att.headerTip } };
        }
        lastErr = new Error(`Horizon ${res.status} @ ${u.toString()} [${att.headerTip}]`);
        if (debugLog) debugLog.push(String(lastErr));
      } catch (e: any) {
        clearTimeout(timer);
        lastErr = e;
        if (debugLog) debugLog.push(`Horizon error: ${(e?.message || e)} @ ${att.url} [${att.headerTip}]`);
      }
      await sleep(200);
    }
  }

  for (let i = 0; i < retries; i++) {
    await sleep(400 * (i + 1));
    const { json, used } = await horizonGet<T>(path, query, pool, apiKey, { retries: 0, timeoutMs, debugLog });
    return { json, used };
  }
  throw lastErr || new Error("All Horizon attempts failed");
}

// ---------- Amount helpers ----------
const toNumber = (s: string | number | null | undefined) =>
  s == null ? 0 : typeof s === "number" ? s : Number(String(s));

/** parse XLM payment amount from Horizon record (string decimal in XLM) */
function parseXlmAmount(amount: any): number | null {
  if (amount == null) return null;
  const n = Number(amount);
  if (!isFinite(n)) return null;
  return n;
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

    // Load wallets and keep only XLM
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true);
    if (wErr) throw wErr;

    const funding = (wallets || [])
      .filter(w => canonChain(String(w.chain)) === "XLM")
      .map(w => ({ id: String(w.id), addr: String((w as any).address || "").trim() }))
      .filter(w => !!w.addr);

    if (!funding.length) {
      return ok({ note: "No active XLM wallets", inserted: 0, scanned: 0 });
    }

    const addrSet = new Set(funding.map(f => f.addr));
    const addrToWallet = new Map(funding.map(f => [f.addr, f.id]));

    // Horizon pool
    const pool = parsePool(process.env.XLM_RPC_POOL, process.env.XLM_RPC_URL || "https://xlm.nownodes.io");
    const apiKey = process.env.NOWNODES_API_KEY || null;

    // Query params
    const url = new URL(req.url);
    const qp = url.searchParams;
    const forceTx = qp.get("tx") || "";
    const sinceLedger = Number(qp.get("sinceLedger") || "0");
    const sinceHours = Number(qp.get("sinceHours") || "0");
    const overlap = Number(qp.get("overlap") || String(DEFAULT_OVERLAP));
    const maxLedgers = Number(qp.get("maxLedgers") || String(DEFAULT_MAX_LEDGERS));
    const minConf = Math.max(0, Number(qp.get("minConf") || String(DEFAULT_MIN_CONF)));
    const richDebug = qp.get("debug") === "1";

    // Tip ledger (last closed)
    const tipQ = await horizonGet<any>("/ledgers", { order: "desc", limit: 1 }, pool, apiKey, { debugLog: dbg });
    const tipLedger = toNumber(tipQ.json?._embedded?.records?.[0]?.sequence) || 0;
    const safeTip = Math.max(0, tipLedger - minConf);

    // Force-single-tx mode
    if (forceTx) {
      // /transactions/{hash}
      const txQ = await horizonGet<any>(`/transactions/${forceTx}`, {}, pool, apiKey, { debugLog: dbg });
      const tx = txQ.json;
      if (!tx || !tx.hash) return err("Transaction not found", 404, { tx: forceTx });

      // /transactions/{hash}/operations?order=asc
      const opsQ = await horizonGet<any>(`/transactions/${forceTx}/operations`, { order: "asc", limit: 200 }, pool, apiKey, { debugLog: dbg });
      const ops: any[] = opsQ.json?._embedded?.records || [];

      let inserted = 0;
      for (const op of ops) {
        if (op?.type !== "payment") continue;
        if (op?.asset_type !== "native") continue;
        const dest = String(op?.to || "");
        if (!addrSet.has(dest)) continue;

        const amount = parseXlmAmount(op?.amount);
        if (amount == null || amount <= 0) continue;

        const whenISO = String(op?.created_at || new Date().toISOString());
        const wallet_id = addrToWallet.get(dest)!;

        const { error: iErr } = await sb
          .from("contributions")
          .upsert([{ wallet_id, tx_hash: forceTx, amount, block_time: whenISO }], { onConflict: "tx_hash" })
          .select("tx_hash");
        if (iErr) throw iErr;
        inserted += 1;
      }

      return ok({
        chain: "xlm",
        mode: "forceTx",
        tipLedger,
        safeTip,
        tx: forceTx,
        inserted,
      });
    }

    // Determine scan range (by ledger sequence)
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
      const body: Json = { tipLedger, safeTip, from, to, scanned: 0, inserted: 0, note: "Nothing to scan (waiting for confirmations)" };
      if (richDebug) (body as any).debugLog = dbg;
      return ok(body);
    }

    // Scan ledgers: /ledgers/{seq}/payments (paged)
    let scanned = 0;
    const rows: Array<{ wallet_id: string; tx_hash: string; amount: number; block_time: string }> = [];

    for (let seq = from; seq <= to; seq++) {
      scanned++;
      let cursor: string | undefined = undefined;

      while (true) {
        const page = await horizonGet<any>(
          `/ledgers/${seq}/payments`,
          {
            order: "asc",
            limit: 200,
            include_failed: "false",
            ...(cursor ? { cursor } : {}),
          },
          pool,
          apiKey,
          { debugLog: dbg }
        );

        const recs: any[] = page.json?._embedded?.records || [];
        if (!recs.length) break;

        for (const p of recs) {
          try {
            if (p?.type !== "payment") continue;
            if (p?.asset_type !== "native") continue;

            const dest = String(p?.to || "");
            if (!addrSet.has(dest)) continue;

            const amount = parseXlmAmount(p?.amount);
            if (amount == null || amount <= 0) continue;

            const whenISO = String(p?.created_at || new Date().toISOString());
            const txHash = String(p?.transaction_hash || "");
            if (!txHash) continue;

            const wallet_id = addrToWallet.get(dest)!;
            rows.push({ wallet_id, tx_hash: txHash, amount, block_time: whenISO });
          } catch {
            // ignore malformed record
          }
        }

        // advance paging within this ledger
        const last = recs[recs.length - 1];
        const nextCursor = String(last?.paging_token || "");
        if (!nextCursor || nextCursor === cursor) break;
        cursor = nextCursor;
      }
    }

    // Upsert matches
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
      chain: "xlm",
      reason,
      tipLedger,
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

