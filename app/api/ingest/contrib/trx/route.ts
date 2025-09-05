// app/api/ingest/contrib/trx/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// Keep Node.js runtime (non-edge)
export const runtime = "nodejs";

/**
 * TRX (Tron) native contributions ingest.
 * - Skenira blokove i hvata `TransferContract` prema našim funding adresama.
 * - Piše u `public.contributions` (wallet_id, tx_hash, amount, block_time).
 * - Marker (zadnji obrađeni blok) je u `public.settings` pod ključem `trx_contrib_last_scanned`.
 *
 * ENV:
 *  - CRON_SECRET
 *  - NEXT_PUBLIC_SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *
 * RPC (NowNodes / Tron FullNode HTTP API):
 *  - TRX_RPC_POOL   (opcionalno; lista baza, comma/newline-separated)
 *  - TRX_RPC_URL    (fallback single base, npr. https://trx.nownodes.io)
 *  - NOWNODES_API_KEY (opcionalno; pokušavamo više header/query varijanti)
 *
 * Query:
 *  - tx=<txid>                   // forsiraj single-tx ingest
 *  - sinceBlock=<n>              // početni blok
 *  - sinceHours=<n>              // vremenski backoff (≈ 3s po bloku)
 *  - overlap=<n=200>             // preskeniraj ovoliko prije markera
 *  - maxBlocks=<n=4000>          // limit po runu
 *  - minConf=<n=12>              // sigurnosni gap od tipa
 *  - debug=1                     // bogat debug
 *
 * Napomena:
 *  - Ne pišemo amount_usd ovdje (radi se drugdje).
 */

// ---------- Tunables & helpers ----------
const DECIMALS = 6;            // 1 TRX = 1e6 SUN
const AVG_BLOCKSEC = 3;
const DEFAULT_MAX_BLOCKS = 4000;
const DEFAULT_MIN_CONF = 12;
const DEFAULT_OVERLAP = 200;
const DEFAULT_BATCH_FALLBACK = 2000;

const CURSOR_KEY = "trx_contrib_last_scanned";

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
  if (v.includes("trx") || v.includes("tron")) return "TRX";
  if (v.includes("sol")) return "SOL";
  if (v.includes("dot") || v.includes("polkadot")) return "DOT";
  if (v.includes("atom") || v.includes("cosmos")) return "ATOM";
  if (v.includes("btc")) return "BTC";
  if (v.includes("ltc")) return "LTC";
  if (v.includes("doge")) return "DOGE";
  if (v.includes("xrp") || v.includes("ripple")) return "XRP";
  if (v.includes("xlm") || v.includes("stellar")) return "XLM";
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
  if (process.env.TRX_PUBLIC_RPC_URL) push(process.env.TRX_PUBLIC_RPC_URL);
  return Array.from(new Set(list));
}

type HttpAttempt = {
  url: string;
  headers: Record<string, string>;
  headerTip: string;
  queryKey?: string;
};

function buildHttpAttempts(base: string, apiKey?: string | null): HttpAttempt[] {
  const attempts: HttpAttempt[] = [];
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

async function tronPost<T = any>(
  path: string,
  body: any,
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
      const u = att.url.replace(/\/+$/, "") + path;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(u, {
          method: "POST",
          headers: att.headers,
          body: JSON.stringify(body ?? {}),
          signal: controller.signal,
        });
        const j = await res.json().catch(() => ({}));
        clearTimeout(timer);
        if (res.ok && !j?.Error) {
          if (debugLog) debugLog.push(`HTTP OK ${path} via ${att.url} [${att.headerTip}]`);
          return { json: j as T, used: { url: att.url, headerTip: att.headerTip } };
        }
        lastErr = new Error(`HTTP ${res.status} ${JSON.stringify(j)} @ ${u} [${att.headerTip}]`);
        if (debugLog) debugLog.push(String(lastErr));
      } catch (e: any) {
        clearTimeout(timer);
        lastErr = e;
        if (debugLog) debugLog.push(`HTTP error: ${(e?.message || e)} @ ${u} [${att.headerTip}]`);
      }
      await sleep(200);
    }
  }

  for (let i = 0; i < retries; i++) {
    await sleep(400 * (i + 1));
    const { json, used } = await tronPost<T>(path, body, pool, apiKey, { retries: 0, timeoutMs, debugLog });
    return { json, used };
  }
  throw lastErr || new Error("All TRX attempts failed");
}

// ---------- Address helpers (Base58Check -> hex "41..." normalizacija) ----------
const B58_ALPH = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const B58_MAP = new Map(B58_ALPH.split("").map((c, i) => [c, i]));

function sha256(buf: Uint8Array): Buffer {
  return crypto.createHash("sha256").update(buf).digest();
}

function b58decode(b58: string): Uint8Array | null {
  let num = BigInt(0);
  for (const c of b58) {
    const v = B58_MAP.get(c);
    if (v == null) return null;
    num = num * BigInt(58) + BigInt(v);
  }
  // convert BigInt -> bytes
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num % 256n));
    num = num / 256n;
  }
  bytes.reverse();
  // handle leading zeros
  let leading = 0;
  for (const c of b58) {
    if (c === "1") leading++;
    else break;
  }
  const res = new Uint8Array(leading + bytes.length);
  res.set(bytes, leading);
  return res;
}

function tronBase58ToHex(addr: string): string | null {
  try {
    const raw = b58decode(addr.trim());
    if (!raw || raw.length < 5) return null;
    const data = raw.subarray(0, raw.length - 4);
    const checksum = raw.subarray(raw.length - 4);
    const h1 = sha256(data);
    const h2 = sha256(h1);
    const calc = h2.subarray(0, 4);
    if (!Buffer.compare(Buffer.from(calc), Buffer.from(checksum)) === 0) {
      // If checksum mismatch, still try (some gateways skip check) -> comment out strictness if needed
    }
    // tron mainnet: version 0x41 + 20 bytes account = 21 bytes total
    const hex = Buffer.from(data).toString("hex").toLowerCase();
    if (!hex.startsWith("41")) return "41" + hex.replace(/^0x/, "");
    return hex;
  } catch {
    return null;
  }
}

function normalizeTronHex(x: string): string {
  const s = (x || "").trim().toLowerCase().replace(/^0x/, "");
  return s.startsWith("41") ? s : (s ? "41" + s : s);
}

function toHexOrEmpty(addr: string): string {
  const a = (addr || "").trim();
  if (!a) return "";
  if (a[0] === "T" || a[0] === "t") {
    return tronBase58ToHex(a) || "";
  }
  return normalizeTronHex(a);
}

// ---------- Amount helper ----------
const sunToTrx = (sun: number | bigint) => Number(sun) / 10 ** DECIMALS;

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

    // Wallets -> samo TRX (normaliziramo adrese u HEX "41..." formu)
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true);
    if (wErr) throw wErr;

    const fundingRaw = (wallets || [])
      .filter(w => canonChain(String(w.chain)) === "TRX")
      .map(w => ({ id: String(w.id), addr: String((w as any).address || "").trim() }))
      .filter(w => !!w.addr);

    if (!fundingRaw.length) return ok({ note: "No active TRX wallets", inserted: 0, scanned: 0 });

    const funding = fundingRaw
      .map(w => {
        const hex = toHexOrEmpty(w.addr);
        return hex ? { id: w.id, hex } : null;
      })
      .filter(Boolean) as { id: string; hex: string }[];

    if (!funding.length) return ok({ note: "TRX wallets present but could not normalize addresses", inserted: 0, scanned: 0 });

    const hexSet = new Set(funding.map(f => f.hex));
    const hexToWallet = new Map(funding.map(f => [f.hex, f.id]));

    // RPC pool
    const pool = parsePool(process.env.TRX_RPC_POOL, process.env.TRX_RPC_URL || "https://trx.nownodes.io");
    const apiKey = process.env.NOWNODES_API_KEY || null;

    // Query
    const url = new URL(req.url);
    const qp = url.searchParams;
    const forceTx = qp.get("tx") || "";
    const sinceBlock = Number(qp.get("sinceBlock") || "0");
    const sinceHours = Number(qp.get("sinceHours") || "0");
    const overlap = Number(qp.get("overlap") || String(DEFAULT_OVERLAP));
    const maxBlocks = Number(qp.get("maxBlocks") || String(DEFAULT_MAX_BLOCKS));
    const minConf = Math.max(0, Number(qp.get("minConf") || String(DEFAULT_MIN_CONF)));
    const richDebug = qp.get("debug") === "1";

    // Tip & safe head: /wallet/getnowblock
    const now = await tronPost<any>("/wallet/getnowblock", {}, pool, apiKey, { debugLog: dbg });
    const tip = Number(now.json?.block_header?.raw_data?.number ?? 0);
    const safeTip = Math.max(0, tip - minConf);

    // Force tx path
    if (forceTx) {
      const txWrap = await tronPost<any>("/wallet/gettransactionbyid", { value: forceTx }, pool, apiKey, { debugLog: dbg });
      const tx = txWrap.json;
      if (!tx || (!tx.txID && !tx.txid)) return err("Transaction not found", 404, { tx: forceTx });

      // contracts
      const contracts: any[] = Array.isArray(tx?.raw_data?.contract) ? tx.raw_data.contract : [];
      const matches: Array<{ wallet_id: string; amount: number }> = [];

      for (const c of contracts) {
        if (c?.type !== "TransferContract") continue;
        const v = c?.parameter?.value || {};
        const toHex = normalizeTronHex(String(v?.to_address || ""));
        const amount = Number(v?.amount || 0);
        if (amount <= 0) continue;
        if (hexSet.has(toHex)) {
          matches.push({ wallet_id: hexToWallet.get(toHex)!, amount: sunToTrx(amount) });
        }
      }

      if (!matches.length) {
        return ok({ note: "No TRX TransferContract to funding addresses", tx: forceTx, inserted: 0 });
      }

      // time: prefer /wallet/gettransactioninfobyid
      let whenISO = new Date().toISOString();
      const inf = await tronPost<any>("/wallet/gettransactioninfobyid", { value: forceTx }, pool, apiKey, { debugLog: dbg });
      const ts = Number(inf.json?.blockTimeStamp || inf.json?.timestamp || 0);
      if (ts > 0) whenISO = new Date(ts).toISOString();

      let inserted = 0;
      for (const m of matches) {
        const { error: iErr } = await sb
          .from("contributions")
          .upsert([{ wallet_id: m.wallet_id, tx_hash: forceTx, amount: m.amount, block_time: whenISO }], { onConflict: "tx_hash" })
          .select("tx_hash");
        if (iErr) throw iErr;
        inserted += 1;
      }

      const res: Json = { chain: "trx", mode: "forceTx", tip, safeTip, tx: forceTx, outputsMatched: matches.length, inserted };
      if (richDebug) (res as any).debugLog = dbg;
      return ok(res);
    }

    // Marker iz settings
    const { data: st } = await sb.from("settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
    const prev = Number(st?.value?.n ?? 0);

    // Odredi range
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
      const blkWrap = await tronPost<any>("/wallet/getblockbynum", { num: h }, pool, apiKey, { debugLog: dbg });
      scanned++;

      const blk = blkWrap.json;
      const tsMs = Number(blk?.block_header?.raw_data?.timestamp || 0);
      const whenISO = tsMs ? new Date(tsMs).toISOString() : new Date().toISOString();

      const txs: any[] = Array.isArray(blk?.transactions) ? blk.transactions : [];
      for (const tx of txs) {
        const sig = String(tx?.txID || tx?.txid || "");
        const contracts: any[] = Array.isArray(tx?.raw_data?.contract) ? tx.raw_data.contract : [];
        // u jednom tx-u može biti više TransferContract; agregiramo po walletu
        const agg = new Map<string, number>(); // wallet_id -> suma TRX u ovom tx-u

        for (const c of contracts) {
          if (c?.type !== "TransferContract") continue;
          const v = c?.parameter?.value || {};
          const toHex = normalizeTronHex(String(v?.to_address || ""));
          const amountSun = Number(v?.amount || 0);
          if (amountSun <= 0) continue;
          if (!hexSet.has(toHex)) continue;
          const wallet_id = hexToWallet.get(toHex)!;
          const amt = sunToTrx(amountSun);
          agg.set(wallet_id, (agg.get(wallet_id) || 0) + amt);
        }

        if (agg.size && sig) {
          for (const [wallet_id, amount] of agg.entries()) {
            rows.push({ wallet_id, tx_hash: sig, amount, block_time: whenISO });
          }
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
      chain: "trx",
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

