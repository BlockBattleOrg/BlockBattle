// app/api/ingest/contrib/btc/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Keep Node.js runtime (fetch/AbortController, non-edge compat)
export const runtime = "nodejs";

/**
 * BTC (Bitcoin) native contributions ingest (UTXO).
 * - Skenira blokove i traži izlaze (vout) čija adresa odgovara našim funding adresama.
 * - Upisuje u `public.contributions` (wallet_id, tx_hash, amount, block_time).
 * - Cursor (zadnji skenirani blok) živi u `public.settings` pod ključem `btc_contrib_last_scanned`.
 *
 * ENV:
 *  - CRON_SECRET
 *  - NEXT_PUBLIC_SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *
 * RPC (NowNodes/kompatibilno):
 *  - BTC_RPC_POOL   (opcionalno; lista baza, comma/newline-separated)
 *  - BTC_RPC_URL    (fallback single base, npr. https://btc.nownodes.io)
 *  - NOWNODES_API_KEY (opcionalno; isprobavamo više header/query varijanti)
 *
 * Query:
 *  - tx=<hash>                    // force single tx ingestion
 *  - sinceBlock=<height>          // start block
 *  - sinceHours=<n>               // vremenski backoff (≈ 6 * n blokova)
 *  - overlap=<n=50>               // ponovno skeniraj ovoliko prije cursora
 *  - maxBlocks=<n=1500>           // limit po runu
 *  - minConf=<n=2>                // potvrde prije uključivanja
 *  - debug=1                      // bogati debug log u odgovoru
 *
 * Napomena:
 *  - Ne pišemo amount_usd ovdje. Cijene se rješavaju drugdje.
 */

// ---------- Tunables & helpers ----------
const DECIMALS = 8;            // BTC ima 8 decimala
const AVG_BLOCKSEC = 600;      // ~10 min
const DEFAULT_MAX_BLOCKS = 1500;
const DEFAULT_MIN_CONF = 2;
const DEFAULT_OVERLAP = 50;
const DEFAULT_BATCH_FALLBACK = 144; // ~1 dan

const CURSOR_KEY = "btc_contrib_last_scanned";

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
  if (process.env.BTC_PUBLIC_RPC_URL) push(process.env.BTC_PUBLIC_RPC_URL);
  return Array.from(new Set(list));
}

type RpcAttempt = { url: string; headers: Record<string, string>; headerTip: string };

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

async function btcRpc<T = any>(
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

  // retry once more through the pool
  for (let i = 0; i < retries; i++) {
    await sleep(400 * (i + 1));
    const { result, used } = await btcRpc<T>(method, params, pool, apiKey, { retries: 0, timeoutMs, debugLog });
    return { result, used };
  }
  throw lastErr || new Error("All RPC attempts failed");
}

// ---------- Helpers ----------
const satToAmount = (sats: bigint) => Number(sats) / 10 ** DECIMALS;

// Extract recipient addresses from a vout.scriptPubKey, covering common shapes
function extractAddresses(spk: any): string[] {
  if (!spk) return [];
  const a1 = Array.isArray(spk.addresses) ? spk.addresses : [];
  const a2 = spk.address ? [spk.address] : [];
  return Array.from(new Set([...a1, ...a2].map((s: string) => (s || "").toLowerCase())));
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

    // Load wallets and filter to BTC
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true);
    if (wErr) throw wErr;

    const funding = (wallets || [])
      .filter(w => canonChain(String(w.chain)) === "BTC")
      .map(w => ({ id: String(w.id), addr: String((w as any).address || "").toLowerCase() }))
      .filter(w => !!w.addr);

    if (!funding.length) {
      return ok({ note: "No active BTC wallets", inserted: 0, scanned: 0 });
    }

    const addrSet = new Set(funding.map(f => f.addr));
    const addrToWallet = new Map(funding.map(f => [f.addr, f.id]));

    // RPC pool
    const pool = parsePool(process.env.BTC_RPC_POOL, process.env.BTC_RPC_URL || "https://btc.nownodes.io");
    const apiKey = process.env.NOWNODES_API_KEY || null;

    // Query params
    const url = new URL(req.url);
    const qp = url.searchParams;
    const forceTx = qp.get("tx") || "";
    const sinceBlock = Number(qp.get("sinceBlock") || "0");
    const sinceHours = Number(qp.get("sinceHours") || "0");
    const overlap = Number(qp.get("overlap") || String(DEFAULT_OVERLAP));
    const maxBlocks = Number(qp.get("maxBlocks") || String(DEFAULT_MAX_BLOCKS));
    const minConf = Math.max(0, Number(qp.get("minConf") || String(DEFAULT_MIN_CONF)));
    const richDebug = qp.get("debug") === "1";

    // Tip & safe head
    const tipCount = await btcRpc<number>("getblockcount", [], pool, apiKey, { debugLog: dbg });
    const tip = tipCount.result;
    const safeTip = Math.max(0, tip - minConf);

    // Force single tx
    if (forceTx) {
      const txRes = await btcRpc<any>("getrawtransaction", [forceTx, true], pool, apiKey, { debugLog: dbg });
      const tx = txRes.result;
      if (!tx || !tx.txid) return err("Transaction not found", 404, { tx: forceTx });

      // need block time
      const bhash = tx.blockhash;
      let whenISO = new Date().toISOString();
      if (bhash) {
        const blk = await btcRpc<any>("getblock", [bhash, 1], pool, apiKey, { debugLog: dbg }); // verbosity 1 has 'time'
        const ts = Number(blk.result?.time || 0);
        if (ts) whenISO = new Date(ts * 1000).toISOString();
      }

      // find matching outputs
      const vouts: any[] = Array.isArray(tx.vout) ? tx.vout : [];
      const matches: Array<{ wallet_id: string; amount: number }> = [];
      for (const v of vouts) {
        const addrs = extractAddresses(v?.scriptPubKey);
        const m = addrs.find(a => addrSet.has(a));
        if (m) {
          const wallet_id = addrToWallet.get(m)!;
          const valueBtc = Number(v?.value || 0); // bitcoind returns BTC float here
          matches.push({ wallet_id, amount: valueBtc });
        }
      }

      if (!matches.length) {
        return ok({ note: "Tx has no outputs to funding addresses", tx: forceTx, inserted: 0 });
      }

      // Ako više naših adresa u istom tx-u, upišemo jedan red po adresi (može kolidirati ako postoji unique(tx_hash); tada DB pravilo pobjeđuje).
      let inserted = 0;
      for (const m of matches) {
        const { error: iErr } = await sb
          .from("contributions")
          .upsert([{ wallet_id: m.wallet_id, tx_hash: tx.txid, amount: m.amount, block_time: whenISO }], { onConflict: "tx_hash" })
          .select("tx_hash");
        if (iErr) throw iErr;
        inserted += 1;
      }

      const res: Json = {
        chain: "btc",
        mode: "forceTx",
        tip,
        safeTip,
        tx: tx.txid,
        outputsMatched: matches.length,
        inserted,
      };
      if (richDebug) res.debugLog = dbg;
      return ok(res);
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
      const approxBlocks = Math.max(1, Math.floor((sinceHours * 3600) / AVG_BLOCKSEC));
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
      if (richDebug) (body as any).debugLog = dbg;
      return ok(body);
    }

    // Scan blocks
    let scanned = 0;
    const rows: Array<{ wallet_id: string; tx_hash: string; amount: number; block_time: string }> = [];

    for (let h = from; h <= to; h++) {
      // get block hash -> block with verbosity 2 (tx objects with vout)
      const bh = await btcRpc<string>("getblockhash", [h], pool, apiKey, { debugLog: dbg });
      const blk = await btcRpc<any>("getblock", [bh.result, 2], pool, apiKey, { debugLog: dbg });
      scanned++;

      const ts = Number(blk.result?.time || 0);
      const whenISO = new Date((ts || 0) * 1000).toISOString();
      const txs: any[] = Array.isArray(blk.result?.tx) ? blk.result.tx : [];

      for (const tx of txs) {
        const vouts: any[] = Array.isArray(tx?.vout) ? tx.vout : [];
        // skupljamo sve pogodke u ovom tx-u; ako se više naših adresa pojavi, upišemo više redova
        const aggPerWallet = new Map<string, number>(); // wallet_id -> suma BTC u ovom tx-u
        for (const v of vouts) {
          const addrs = extractAddresses(v?.scriptPubKey);
          for (const a of addrs) {
            if (!addrSet.has(a)) continue;
            const wallet_id = addrToWallet.get(a)!;
            const val = Number(v?.value || 0);
            aggPerWallet.set(wallet_id, (aggPerWallet.get(wallet_id) || 0) + val);
          }
        }
        if (aggPerWallet.size) {
          for (const [wallet_id, amount] of aggPerWallet.entries()) {
            rows.push({ wallet_id, tx_hash: String(tx?.txid || tx?.hash || ""), amount, block_time: whenISO });
          }
        }
      }
    }

    // Upsert
    let inserted = 0;
    if (rows.length) {
      // U nekim bazama imamo unique(tx_hash), u nekima nemamo — ostavljamo onConflict na "tx_hash" (kao i EVM rute).
      const { data: upserted, error: iErr } = await sb
        .from("contributions")
        .upsert(rows, { onConflict: "tx_hash" })
        .select("tx_hash");
      if (iErr) throw iErr;
      inserted = upserted?.length || 0;
    }

    // Move cursor
    await sb.from("settings").upsert({ key: CURSOR_KEY, value: { n: to } }, { onConflict: "key" });

    const res: Json = {
      ok: true,
      chain: "btc",
      reason,
      tip,
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
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

