// app/api/ingest/contrib/atom/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Node runtime (fetch/AbortController)
export const runtime = "nodejs";

/**
 * ATOM (Cosmos Hub) native contributions ingest.
 * - Čita transakcije po blokovima iz LCD (gRPC-gateway) i traži MsgSend (uatom) prema našim funding adresama.
 * - Piše u `public.contributions` (wallet_id, tx_hash, amount, block_time).
 * - Marker (zadnji skenirani blok) čuvamo u `public.settings` pod ključem `atom_contrib_last_scanned`.
 *
 * ENV:
 *  - CRON_SECRET
 *  - NEXT_PUBLIC_SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *
 * LCD pool (NowNodes ili javni REST endpoints):
 *  - ATOM_LCD_POOL   (opcionalno; lista baza, comma/newline-separated, npr. https://cosmoshub-lcd.stakewolle.com)
 *  - ATOM_LCD_URL    (fallback single base)
 *  - NOWNODES_API_KEY (opcionalno; probavamo više header/query varijanti)
 *
 * Query:
 *  - tx=<hash>                      // forsiraj single tx ingest
 *  - sinceBlock=<n>                 // početni blok (visina)
 *  - sinceHours=<n>                 // vremenski backoff (~6s/block)
 *  - overlap=<n=300>                // re-scan toliki broj blokova iza markera
 *  - maxBlocks=<n=1800>             // limit blokova po runu
 *  - minConf=<n=3>                  // sigurnosni razmak iza tipa
 *  - debug=1                        // uključi detaljan debug
 *
 * Napomena:
 *  - amount_usd se ne računa ovdje.
 */

// ---------- Tunables ----------
const DECIMALS = 6;                // 1 ATOM = 1e6 uatom
const AVG_BLOCKSEC = 6;            // gruba aproksimacija
const DEFAULT_MAX_BLOCKS = 1800;   // ~3h skeniranja max
const DEFAULT_MIN_CONF = 3;
const DEFAULT_OVERLAP = 300;
const DEFAULT_BATCH_FALLBACK = 1200;

const CURSOR_KEY = "atom_contrib_last_scanned";

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

// Canonical chain normalizer
function canonChain(x: string | null | undefined): string {
  const v = (x || "").toLowerCase();
  if (v.includes("atom") || v.includes("cosmos")) return "ATOM";
  if (v.includes("dot") || v.includes("polkadot")) return "DOT";
  if (v.includes("btc") || v.includes("bitcoin")) return "BTC";
  if (v.includes("ltc") || v.includes("litecoin")) return "LTC";
  if (v.includes("doge")) return "DOGE";
  if (v.includes("xrp") || v.includes("ripple")) return "XRP";
  if (v.includes("xlm") || v.includes("stellar")) return "XLM";
  if (v.includes("sol")) return "SOL";
  if (v.includes("trx") || v.includes("tron")) return "TRX";
  if (v.includes("bsc") || v.includes("bnb")) return "BNB";
  if (v.includes("eth")) return "ETH";
  return v.toUpperCase();
}

// ---------- LCD pool & auth fallbacks ----------
function parsePool(envPool?: string, envSingle?: string) {
  const list: string[] = [];
  const push = (s?: string) => {
    if (!s) return;
    const t = s.trim().replace(/\/+$/, "");
    if (t) list.push(t);
  };
  if (envPool) for (const part of envPool.split(/[\n,]+/)) push(part);
  push(envSingle);
  if (process.env.ATOM_PUBLIC_LCD_URL) push(process.env.ATOM_PUBLIC_LCD_URL);
  // par korisnih defaultova ako želiš (možeš ih staviti u ATOM_LCD_POOL u env-u):
  // https://lcd-cosmoshub.keplr.app , https://cosmoshub-lcd.stakewolle.com , https://lcd-cosmoshub.blockapsis.com
  return Array.from(new Set(list));
}

type HttpAttempt = { url: string; headers: Record<string, string>; headerTip: string; queryKey?: string };

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
    attempts.push({ url: clean, headers: baseHeaders, queryKey: "apikey", headerTip: "query:apikey" });
    attempts.push({ url: clean, headers: baseHeaders, queryKey: "api_key", headerTip: "query:api_key" });
    attempts.push({ url: clean, headers: baseHeaders, queryKey: "apiKey", headerTip: "query:apiKey" });
  } else {
    attempts.push({ url: clean, headers: baseHeaders, headerTip: "no-key" });
  }
  return attempts;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function lcdGet<T = any>(
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
        const j = await res.json().catch(() => ({} as any));
        clearTimeout(timer);
        if (res.ok && !(j as any)?.code) {
          if (debugLog) debugLog.push(`LCD OK ${u.pathname} via ${att.url} [${att.headerTip}]`);
          return { json: j as T, used: { url: att.url, headerTip: att.headerTip } };
        }
        lastErr = new Error(`LCD ${res.status} @ ${u.toString()} [${att.headerTip}] => ${JSON.stringify(j).slice(0, 200)}`);
        if (debugLog) debugLog.push(String(lastErr));
      } catch (e: any) {
        clearTimeout(timer);
        lastErr = e;
        if (debugLog) debugLog.push(`LCD error: ${(e?.message || e)} @ ${att.url} [${att.headerTip}]`);
      }
      await sleep(200);
    }
  }

  for (let i = 0; i < retries; i++) {
    await sleep(400 * (i + 1));
    const { json, used } = await lcdGet<T>(path, query, pool, apiKey, { retries: 0, timeoutMs, debugLog });
    return { json, used };
  }
  throw lastErr || new Error("All LCD attempts failed");
}

// ---------- Helpers ----------
function uatomToAtom(s: string | number): number {
  const n = typeof s === "number" ? s : Number(s || 0);
  return n / 10 ** DECIMALS;
}

function extractAtomFromAmounts(amounts: any): number {
  // amounts: [{ denom: "uatom", amount: "12345" }, ...]
  const arr = Array.isArray(amounts) ? amounts : [];
  for (const a of arr) {
    if ((a?.denom || "").toLowerCase() === "uatom") {
      const v = uatomToAtom(a?.amount || "0");
      if (v > 0) return v;
    }
  }
  return 0;
}

// ---------- Main handler ----------
export async function POST(req: Request) {
  const dbg: string[] = [];
  try {
    // Auth
    const expected = need("CRON_SECRET");
    if ((req.headers.get("x-cron-secret") || "") !== expected) return err("Unauthorized", 401);

    const sb = supa();

    // Wallets -> ATOM
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true);
    if (wErr) throw wErr;

    const funding = (wallets || [])
      .filter(w => canonChain(String(w.chain)) === "ATOM")
      .map(w => ({ id: String(w.id), addr: String((w as any).address || "").trim() }))
      .filter(w => !!w.addr);

    if (!funding.length) return ok({ note: "No active ATOM wallets", inserted: 0, scanned: 0 });

    const addrSet = new Set(funding.map(f => f.addr));
    const addrToWallet = new Map(funding.map(f => [f.addr, f.id]));

    // LCD pool
    const pool = parsePool(process.env.ATOM_LCD_POOL, process.env.ATOM_LCD_URL || "https://cosmoshub-lcd.stakewolle.com");
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

    // Tip & safe head
    const latest = await lcdGet<any>("/cosmos/base/tendermint/v1beta1/blocks/latest", {}, pool, apiKey, { debugLog: dbg });
    const tip = Number(latest.json?.block?.header?.height || latest.json?.block?.header?.height?.height || 0);
    const safeTip = Math.max(0, tip - minConf);

    // Force single tx
    if (forceTx) {
      const txq = await lcdGet<any>(`/cosmos/tx/v1beta1/txs/${forceTx}`, {}, pool, apiKey, { debugLog: dbg });
      const tx = txq.json?.tx;
      const txResp = txq.json?.tx_response;
      if (!tx || !txResp) return err("Transaction not found", 404, { tx: forceTx });

      const whenISO = String(txResp.timestamp || new Date().toISOString());
      let inserted = 0;

      const msgs: any[] = Array.isArray(tx?.body?.messages) ? tx.body.messages : [];
      for (const m of msgs) {
        // @typeUrl: "/cosmos.bank.v1beta1.MsgSend"
        const t = String(m?.["@type"] || m?.typeUrl || "");
        if (!t.includes("MsgSend")) continue;

        const to = String(m?.to_address || m?.toAddress || "");
        if (!addrSet.has(to)) continue;

        const amount = extractAtomFromAmounts(m?.amount);
        if (amount <= 0) continue;

        const wallet_id = addrToWallet.get(to)!;
        const { error: iErr } = await sb
          .from("contributions")
          .upsert([{ wallet_id, tx_hash: String(txResp.txhash || ""), amount, block_time: whenISO }], { onConflict: "tx_hash" })
          .select("tx_hash");
        if (iErr) throw iErr;
        inserted += 1;
      }

      const res: Json = { chain: "atom", mode: "forceTx", tip, safeTip, tx: String(txResp.txhash || ""), inserted };
      if (richDebug) (res as any).debugLog = dbg;
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

    // Scan: za svaki blok, povuci tx-eve preko /cosmos/tx/v1beta1/txs?events=tx.height=H
    let scanned = 0;
    const rows: Array<{ wallet_id: string; tx_hash: string; amount: number; block_time: string }> = [];

    for (let h = from; h <= to; h++) {
      const txsQ = await lcdGet<any>(
        "/cosmos/tx/v1beta1/txs",
        {
          // events supports multiple; ovdje gledamo točno taj blok
          "events": `tx.height=${h}`,
          "order_by": "ORDER_BY_UNSPECIFIED",
          "page": 1,
          "limit": 200,
        },
        pool,
        apiKey,
        { debugLog: dbg }
      );
      scanned++;

      const txs: any[] = Array.isArray(txsQ.json?.txs) ? txsQ.json.txs : [];
      const txResps: any[] = Array.isArray(txsQ.json?.tx_responses) ? txsQ.json.tx_responses : [];
      const byHashTime = new Map<string, string>();
      for (const r of txResps) {
        byHashTime.set(String(r?.txhash || ""), String(r?.timestamp || ""));
      }

      for (const tx of txs) {
        const msgs: any[] = Array.isArray(tx?.body?.messages) ? tx.body.messages : [];
        const txhash = String((tx as any)?.hash || "");
        // Ako LCD ne vraća hash u tx objektu, uzmi iz paralelnog niza odgovora
        const hash = txhash || (txResps.find(r => (r?.tx?.body?.messages || []) === msgs) as any)?.txhash || "";

        const whenISO = byHashTime.get(hash) || new Date().toISOString();

        // agregiraj per-wallet u ovom tx-u
        const agg = new Map<string, number>();
        for (const m of msgs) {
          const t = String(m?.["@type"] || m?.typeUrl || "");
          if (!t.includes("MsgSend")) continue;

          const to = String(m?.to_address || m?.toAddress || "");
          if (!addrSet.has(to)) continue;

          const amount = extractAtomFromAmounts(m?.amount);
          if (amount <= 0) continue;

          agg.set(to, (agg.get(to) || 0) + amount);
        }

        if (agg.size && hash) {
          for (const [to, amount] of agg.entries()) {
            const wallet_id = addrToWallet.get(to)!;
            rows.push({ wallet_id, tx_hash: hash, amount, block_time: whenISO });
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

    // Spremi marker
    await sb.from("settings").upsert({ key: CURSOR_KEY, value: { n: to } }, { onConflict: "key" });

    const res: Json = {
      ok: true,
      chain: "atom",
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

