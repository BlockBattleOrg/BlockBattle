// app/api/ingest/contrib/arb/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Keep Node.js runtime for fetch/AbortController and non-edge compat
export const runtime = "nodejs";

/**
 * ARB (Arbitrum) native contributions ingest (EVM).
 * - Scans blocks and picks txs where `to` equals one of our funding addresses.
 * - Writes into `public.contributions` (wallet_id, tx_hash, amount, block_time).
 * - Cursor (last scanned block) lives in `public.settings` under `arb_contrib_last_scanned`.
 *
 * ENV required:
 *  - CRON_SECRET
 *  - NEXT_PUBLIC_SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *
 * Preferred ENV for RPC (NowNodes):
 *  - ARB_RPC_POOL   (optional, comma/newline-separated list of base URLs)
 *  - ARB_RPC_URL    (fallback single base, e.g. https://arbitrum.nownodes.io)
 *  - NOWNODES_API_KEY (optional; multiple header/query variants attempted)
 *
 * Query params:
 *  - tx=<hash>                    // force single tx ingest path
 *  - sinceBlock=<height>          // start from height
 *  - sinceHours=<n>               // approximate backoff by time
 *  - overlap=<n=100>              // re-scan this many blocks before cursor
 *  - maxBlocks=<n=2000>           // hard limit per run
 *  - minConf=<n=6>                // confirmations before including a block
 *  - debug=1                      // include rich debug info
 *
 * IMPORTANT:
 *  - We DO NOT write amount_usd here. Pricing is handled elsewhere.
 */

// ---------- Tunables & helpers ----------
const DECIMALS = 18; // ARB native = ETH units
const AVG_BLOCKSEC = 1; // for backoff approximation only
const DEFAULT_MAX_BLOCKS = 2000;
the const DEFAULT_MIN_CONF = 6;
const DEFAULT_OVERLAP = 100;
const DEFAULT_BATCH_FALLBACK = 500; // small conservative window on first run

const CURSOR_KEY = "arb_contrib_last_scanned";

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

// Canonical chain ticker normalizer; shared logic across EVM routes.
function canonChain(x: string | null | undefined): string {
  const v = (x || "").toLowerCase();
  if (v.includes("eth") || v.includes("ethereum")) return "ETH";
  if (v.includes("bsc") || v.includes("bnb")) return "BNB";
  if (v.includes("matic") || v.includes("polygon") || v === "pol") return "POL";
  if (v.startsWith("arb")) return "ARB";
  if (v === "op" || v.includes("optimism")) return "OP";
  if (v.includes("avax") || v.includes("avalanche")) return "AVAX";
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

  if (envPool) {
    for (const part of envPool.split(/[\n,]+/)) push(part);
  }
  push(envSingle);

  // Minimal last-resort (only if provided by user)
  if (process.env.ARB_PUBLIC_RPC_URL) push(process.env.ARB_PUBLIC_RPC_URL);

  return Array.from(new Set(list));
}

type RpcAttempt = {
  url: string;
  headers: Record<string, string>;
  queryAppend?: string;
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
    attempts.push({ url: `${clean}?apikey=${encodeURIComponent(k)}`, headers: baseHeaders, headerTip: "query:apikey", queryAppend: "apikey" });
    attempts.push({ url: `${clean}?api_key=${encodeURIComponent(k)}`, headers: baseHeaders, headerTip: "query:api_key", queryAppend: "api_key" });
    attempts.push({ url: `${clean}?apiKey=${encodeURIComponent(k)}`, headers: baseHeaders, headerTip: "query:apiKey", queryAppend: "apiKey" });
  } else {
    attempts.push({ url: clean, headers: baseHeaders, headerTip: "no-key" });
  }
  return attempts;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function evmRpc<T = any>(
  method: string,
  params: any[],
  pool: string[],
  apiKey?: string | null,
  opts?: { retries?: number; timeoutMs?: number; signal?: AbortSignal; debugLog?: string[] }
): Promise<{ result: T; used: { url: string; headerTip: string } }> {
  const retries = opts?.retries ?? 2;
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const debugLog = opts?.debugLog;

  let lastErr: any = null;

  for (const base of pool) {
    const variants = buildRpcAttempts(base, apiKey);
    for (const att of variants) {
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
          return { result: j.result as T, used: { url: att.url, headerTip: att.headerTip } };
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

  for (let i = 0; i < (opts?.retries ?? 2); i++) {
    await sleep(400 * (i + 1));
    const { result, used } = await evmRpc<T>(method, params, pool, apiKey, { retries: 0, timeoutMs, debugLog });
    return { result, used };
  }

  throw lastErr || new Error("All RPC attempts failed");
}

// Hex helpers
const hexToNum = (h: string) => parseInt(h.startsWith("0x") ? h.slice(2) : h, 16);
const toBN = (h?: string | null) => BigInt((h || "0x0").startsWith("0x") ? (h || "0x0") : `0x${h}`);
const weiToAmount = (wei: bigint) => Number(wei) / 10 ** DECIMALS;

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

    // Load wallets and filter to ARB via canonChain
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true);
    if (wErr) throw wErr;

    const funding = (wallets || [])
      .filter(w => canonChain(String(w.chain)) === "ARB")
      .map(w => ({ id: String(w.id), addr: String((w as any).address || "").toLowerCase() }))
      .filter(w => !!w.addr);

    if (!funding.length) {
      return ok({ note: "No active ARB wallets", inserted: 0, scanned: 0 });
    }

    const addrMap = new Map<string, string>();
    for (const w of funding) addrMap.set(w.addr, w.id);

    // RPC pool
    const pool = parsePool(process.env.ARB_RPC_POOL, process.env.ARB_RPC_URL || "https://arbitrum.nownodes.io");
    const apiKey = process.env.NOWNODES_API_KEY || null;

    // Parse query
    const url = new URL(req.url);
    const qp = url.searchParams;
    const forceTx = qp.get("tx") || "";
    const sinceBlock = Number(qp.get("sinceBlock") || "0");
    const sinceHours = Number(qp.get("sinceHours") || "0");
    const overlap = Number(qp.get("overlap") || String(DEFAULT_OVERLAP));
    const maxBlocks = Number(qp.get("maxBlocks") || String(DEFAULT_MAX_BLOCKS));
    const minConf = Math.max(0, Number(qp.get("minConf") || String(DEFAULT_MIN_CONF)));
    const richDebug = qp.get("debug") === "1";

    // Tip and safe head
    const tipRes = await evmRpc<string>("eth_blockNumber", [], pool, apiKey, { debugLog: dbg });
    const tip = hexToNum(tipRes.result);
    const safeTip = Math.max(0, tip - minConf);

    // Force single tx mode
    if (forceTx) {
      const txRes = await evmRpc<any>("eth_getTransactionByHash", [forceTx], pool, apiKey, { debugLog: dbg });
      const tx = txRes.result;
      if (!tx || !tx.hash) return err("Transaction not found", 404, { tx: forceTx });

      const to = String(tx.to || "").toLowerCase();
      const wallet_id = addrMap.get(to);
      if (!wallet_id) {
        return ok({
          note: "Tx not to a funding address",
          tx: forceTx,
          to,
          funding: funding.map(f => f.addr).slice(0, 10),
        });
      }

      // Block time
      const blockNum = hexToNum(String(tx.blockNumber || "0x0"));
      const blkRes = await evmRpc<any>("eth_getBlockByNumber", [tx.blockNumber, false], pool, apiKey, { debugLog: dbg });
      const ts = hexToNum(String(blkRes.result?.timestamp || "0x0"));
      const whenISO = new Date(ts * 1000).toISOString();

      // Insert (NO amount_usd)
      const amount = weiToAmount(toBN(tx.value));
      const { error: iErr } = await sb
        .from("contributions")
        .upsert([{ wallet_id, tx_hash: tx.hash, amount, block_time: whenISO }], { onConflict: "tx_hash" });
      if (iErr) throw iErr;

      // Cursor forward
      await sb.from("settings").upsert({ key: CURSOR_KEY, value: { n: blockNum } }, { onConflict: "key" });

      const resBody: Json = {
        chain: "arb",
        mode: "forceTx",
        tip,
        safeTip,
        tx: tx.hash,
        to,
        inserted: 1,
        rpcTipFrom: tipRes.used,
        rpcHeadersUsed: tipRes.used?.headerTip,
      };
      if (richDebug) resBody.debugLog = dbg;
      return ok(resBody);
    }

    // Determine range
    const { data: st } = await sb.from("settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
    const prev = Number(st?.value?.n ?? 0);

    let from: number;
    let reason = "";

    if (sinceBlock > 0) {
      from = sinceBlock;
      reason = "sinceBlock";
    } else if (sinceHours > 0) {
      const approxBlocks = Math.floor((sinceHours * 3600) / AVG_BLOCKSEC);
      from = Math.max(0, safeTip - approxBlocks);
      reason = "sinceHours";
    } else if (prev > 0) {
      from = Math.max(0, prev - overlap + 1);
      reason = "marker/overlap";
    } else {
      from = Math.max(0, safeTip - Math.min(DEFAULT_BATCH_FALLBACK, maxBlocks) + 1);
      reason = "fallback";
    }

    let to = Math.min(safeTip, from + Math.max(1, maxBlocks) - 1);
    if (to < from) {
      const body: Json = { tip, safeTip, from, to, scanned: 0, inserted: 0, note: "Nothing to scan (waiting for confirmations)" };
      if (richDebug) {
        body.rpcTipFrom = tipRes.used;
        body.debugLog = dbg;
        body.funding = funding.map(f => f.addr);
      }
      return ok(body);
    }

    // Scan
    let scanned = 0;
    const rows: Array<{ wallet_id: string; tx_hash: string; amount: number; block_time: string }> = [];

    for (let h = from; h <= to; h++) {
      const blockHex = `0x${h.toString(16)}`;
      const { result: block } = await evmRpc<any>("eth_getBlockByNumber", [blockHex, true], pool, apiKey, { debugLog: dbg });
      scanned++;

      const ts = hexToNum(String(block?.timestamp || "0x0"));
      const whenISO = new Date(ts * 1000).toISOString();
      const txs: any[] = Array.isArray(block?.transactions) ? block.transactions : [];

      for (const tx of txs) {
        const to = String(tx?.to || "").toLowerCase();
        const wallet_id = to ? addrMap.get(to) : undefined;
        if (!wallet_id) continue;

        const val = toBN(tx.value);
        if (val <= 0n) continue;

        // Status via receipt
        const { result: rcpt } = await evmRpc<any>("eth_getTransactionReceipt", [tx.hash], pool, apiKey, { debugLog: dbg });
        const statusOk = String(rcpt?.status || "0x1") !== "0x0";
        if (!statusOk) continue;

        rows.push({
          wallet_id,
          tx_hash: tx.hash,
          amount: weiToAmount(val),
          block_time: whenISO,
        });
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
      chain: "arb",
      reason,
      tip,
      safeTip,
      from,
      to,
      scanned,
      matched: rows.length,
      inserted,
      rpcTipFrom: tipRes.used,
      funding: richDebug ? funding.map(f => f.addr) : undefined,
      rpcHeadersUsed: richDebug ? tipRes.used?.headerTip : undefined,
    };
    if (richDebug) res.debugLog = dbg;
    return NextResponse.json(res);
  } catch (e: any) {
    const msg = String(e?.message || e);
    const body: Json = { ok: false, error: msg };
    return NextResponse.json(body, { status: 500 });
  }
}

