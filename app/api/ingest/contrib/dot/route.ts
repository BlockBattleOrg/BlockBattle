// app/api/ingest/contrib/dot/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// Keep Node.js runtime (non-edge)
export const runtime = "nodejs";

/**
 * DOT (Polkadot) native contributions ingest.
 * - Dohvaća tip i siguran vrh (finalized) preko Substrate JSON-RPC.
 * - Po blokovima dohvaća evente (Balances.Transfer) preko indexera (Subscan-style API).
 * - U `public.contributions` sprema (wallet_id, tx_hash, amount, block_time).
 * - Marker (zadnji obrađeni blok) je u `public.settings` pod ključem `dot_contrib_last_scanned`.
 *
 * ENV:
 *  - CRON_SECRET
 *  - NEXT_PUBLIC_SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *
 * JSON-RPC (tip/safeTip):
 *  - DOT_RPC_POOL   (opcionalno; lista baza, comma/newline)
 *  - DOT_RPC_URL    (fallback single base; npr. https://rpc.polkadot.io ili https://dot.nownodes.io)
 *  - NOWNODES_API_KEY (opcionalno; probamo više header/query varijanti)
 *
 * Indexer (events):
 *  - DOT_INDEXER_POOL (opcionalno; lista baza, npr. https://polkadot.api.subscan.io)
 *  - DOT_INDEXER_URL  (fallback single base)
 *  - SUBSCAN_API_KEY  (opcionalno; header X-API-Key / varijante)
 *
 * Query:
 *  - tx=<hash>                    // forsiraj single-tx ingest (preko indexera detail endpointa)
 *  - sinceBlock=<n>               // početni blok
 *  - sinceHours=<n>               // vremenski backoff (≈ 6s/block)
 *  - overlap=<n=120>              // re-scan iza markera
 *  - maxBlocks=<n=240>            // limit po runu
 *  - minConf=<n=3>                // sigurnosni gap od finalized tipa
 *  - debug=1                      // bogat debug
 *
 * Napomena:
 *  - amount_usd se ne zapisuje ovdje.
 */

// ---------- Tunables & helpers ----------
const DECIMALS = 10;             // 1 DOT = 1e10 Planck
const AVG_BLOCKSEC = 6;
const DEFAULT_MAX_BLOCKS = 240;  // ~24 min max
const DEFAULT_MIN_CONF = 3;
const DEFAULT_OVERLAP = 120;
const DEFAULT_BATCH_FALLBACK = 180;

const CURSOR_KEY = "dot_contrib_last_scanned";

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

// Canonical chain (isti obrazac kao drugdje)
function canonChain(x: string | null | undefined): string {
  const v = (x || "").toLowerCase();
  if (v.includes("dot") || v.includes("polkadot")) return "DOT";
  if (v.includes("atom") || v.includes("cosmos")) return "ATOM";
  if (v.includes("btc")) return "BTC";
  if (v.includes("ltc")) return "LTC";
  if (v.includes("doge")) return "DOGE";
  if (v.includes("xrp") || v.includes("ripple")) return "XRP";
  if (v.includes("xlm") || v.includes("stellar")) return "XLM";
  if (v.includes("sol")) return "SOL";
  if (v.includes("trx") || v.includes("tron")) return "TRX";
  if (v.includes("bsc") || v.includes("bnb")) return "BNB";
  if (v.includes("eth")) return "ETH";
  return v.toUpperCase();
}

// ---------- Pools & auth fallbacks ----------
function parsePool(envPool?: string, envSingle?: string, extra?: string[]) {
  const list: string[] = [];
  const push = (s?: string) => {
    if (!s) return;
    const t = s.trim().replace(/\/+$/, "");
    if (t) list.push(t);
  };
  if (envPool) for (const part of envPool.split(/[\n,]+/)) push(part);
  push(envSingle);
  (extra || []).forEach(push);
  return Array.from(new Set(list));
}

type Attempt = { url: string; headers: Record<string, string>; headerTip: string; queryKey?: string };

function buildAttempts(base: string, apiKey?: string | null): Attempt[] {
  const clean = base.replace(/\/+$/, "");
  const baseHeaders: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  const attempts: Attempt[] = [];

  if (apiKey && apiKey.trim()) {
    const k = apiKey.trim();
    // common
    attempts.push({ url: clean, headers: { ...baseHeaders, "api-key": k }, headerTip: "api-key" });
    attempts.push({ url: clean, headers: { ...baseHeaders, "x-api-key": k }, headerTip: "x-api-key" });
    attempts.push({ url: clean, headers: { ...baseHeaders, "X-API-KEY": k }, headerTip: "X-API-KEY" });
    attempts.push({ url: clean, headers: { ...baseHeaders, Authorization: `Bearer ${k}` }, headerTip: "Bearer" });
    // query variants (za neke gatewaye)
    attempts.push({ url: `${clean}?apikey=${encodeURIComponent(k)}`, headers: baseHeaders, headerTip: "query:apikey", queryKey: "apikey" });
    attempts.push({ url: `${clean}?api_key=${encodeURIComponent(k)}`, headers: baseHeaders, headerTip: "query:api_key", queryKey: "api_key" });
    attempts.push({ url: `${clean}?apiKey=${encodeURIComponent(k)}`, headers: baseHeaders, headerTip: "query:apiKey", queryKey: "apiKey" });
    // Subscan specifično
    attempts.push({ url: clean, headers: { ...baseHeaders, "X-API-Key": k }, headerTip: "X-API-Key" });
  } else {
    attempts.push({ url: clean, headers: baseHeaders, headerTip: "no-key" });
  }
  return attempts;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- JSON-RPC (tip/safe head) ----------
async function dotRpc<T = any>(
  method: string,
  params: any[],
  pool: string[],
  apiKey?: string | null,
  opts?: { retries?: number; timeoutMs?: number; debugLog?: string[] }
): Promise<{ result: T; used: { url: string; headerTip: string } }> {
  const retries = opts?.retries ?? 1;
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const debugLog = opts?.debugLog;
  let lastErr: any = null;

  for (const base of pool) {
    for (const att of buildAttempts(base, apiKey)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(att.url, {
          method: "POST",
          headers: att.headers,
          body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
          signal: controller.signal,
        });
        const j = await res.json().catch(() => ({}));
        clearTimeout(timer);
        if (res.ok && !j?.error) {
          if (debugLog) debugLog.push(`RPC OK ${method} via ${att.url} [${att.headerTip}]`);
          return { result: (j.result ?? j) as T, used: { url: att.url, headerTip: att.headerTip } };
        }
        lastErr = new Error(`RPC ${res.status} ${JSON.stringify(j?.error || {})} @ ${att.url} [${att.headerTip}]`);
        if (debugLog) debugLog.push(String(lastErr));
      } catch (e: any) {
        clearTimeout(timer);
        lastErr = e;
        if (debugLog) debugLog.push(`RPC error: ${(e?.message || e)} @ ${att.url} [${att.headerTip}]`);
      }
      await sleep(150);
    }
  }

  if (retries > 0) {
    await sleep(400);
    return dotRpc<T>(method, params, pool, apiKey, { retries: retries - 1, timeoutMs, debugLog });
  }
  throw lastErr || new Error("All DOT RPC attempts failed");
}

function hexToNum(hex?: string): number {
  if (!hex) return 0;
  return Number(BigInt(hex));
}

// ---------- Indexer (events / transactions) ----------
async function postIndexer<T = any>(
  baseUrl: string,
  path: string,
  body: any,
  apiKey?: string | null,
  dbg?: string[]
): Promise<T | null> {
  for (const att of buildAttempts(baseUrl, apiKey)) {
    const u = att.url.replace(/\/+$/, "") + path;
    try {
      const res = await fetch(u, {
        method: "POST",
        headers: { ...att.headers }, // includes potential API key header
        body: JSON.stringify(body ?? {}),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && (j?.code === 0 || j?.message === "Success" || j?.data || j?.event)) {
        dbg?.push(`INDEXER OK ${path} via ${baseUrl} [${att.headerTip}]`);
        return j?.data || j; // subscan returns {code, message, data}
      }
      dbg?.push(`INDEXER bad ${res.status} @ ${u} [${att.headerTip}] => ${JSON.stringify(j).slice(0, 180)}`);
    } catch (e: any) {
      dbg?.push(`INDEXER error ${e?.message || e} @ ${u} [${att.headerTip}]`);
    }
    await sleep(120);
  }
  return null;
}

function planckToDot(n: string | number): number {
  const v = typeof n === "number" ? n : Number(n || 0);
  return v / 10 ** DECIMALS;
}

// Robust extraction iz Subscan event objekta
function pickTransfersFromEvents(evts: any[]): Array<{ to: string; amount: number; hash: string }> {
  const out: Array<{ to: string; amount: number; hash: string }> = [];
  const arr = Array.isArray(evts) ? evts : [];
  for (const e of arr) {
    const moduleId = String(e?.module_id || e?.section || "").toLowerCase();
    const eventId = String(e?.event_id || e?.event || e?.name || "").toLowerCase();
    if (!(moduleId === "balances" && eventId === "transfer")) continue;

    // params varira po API verziji
    let from = "";
    let to = "";
    let amount = 0;

    const params = Array.isArray(e?.params) ? e.params : Array.isArray(e?.event_data) ? e.event_data : [];
    if (Array.isArray(params) && params.length >= 3) {
      // pokušaj standardnog SUBSCAN formata: [{type:'AccountId', value:'...'}, ...]
      const p0 = params[0];
      const p1 = params[1];
      const p2 = params[2];
      const val = (x: any) => (typeof x === "object" && x && "value" in x ? x.value : x);
      from = String(val(p0) || "");
      to = String(val(p1) || "");
      amount = planckToDot(val(p2) || "0");
    } else {
      // fallback: pokušaj iz polja 'data'
      const data = Array.isArray(e?.data) ? e.data : [];
      if (data.length >= 3) {
        from = String(data[0] || "");
        to = String(data[1] || "");
        amount = planckToDot(data[2] || "0");
      }
    }

    if (!to || amount <= 0) continue;

    const hash = String(e?.extrinsic_hash || e?.extrinsic_hash_hex || e?.event_index || e?.block_hash || "");
    out.push({ to, amount, hash });
  }
  return out;
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

    // Wallets -> samo DOT SS58 adrese (string match)
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true);
    if (wErr) throw wErr;

    const funding = (wallets || [])
      .filter(w => canonChain(String(w.chain)) === "DOT")
      .map(w => ({ id: String(w.id), addr: String((w as any).address || "").trim() }))
      .filter(w => !!w.addr);

    if (!funding.length) return ok({ note: "No active DOT wallets", inserted: 0, scanned: 0 });

    const addrSet = new Set(funding.map(f => f.addr));
    const addrToWallet = new Map(funding.map(f => [f.addr, f.id]));

    // Pools
    const rpcPool = parsePool(process.env.DOT_RPC_POOL, process.env.DOT_RPC_URL, [
      "https://rpc.polkadot.io",
      "https://dot.nownodes.io",
    ]);
    const rpcKey = process.env.NOWNODES_API_KEY || null;

    const indexerPool = parsePool(process.env.DOT_INDEXER_POOL, process.env.DOT_INDEXER_URL, [
      "https://polkadot.api.subscan.io",
    ]);
    const subscanKey = process.env.SUBSCAN_API_KEY || null;

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

    // Tip & safe head (finalized)
    const finHead = await dotRpc<string>("chain_getFinalizedHead", [], rpcPool, rpcKey, { debugLog: dbg });
    const finHash = finHead.result;
    const finHeader = await dotRpc<any>("chain_getHeader", [finHash], rpcPool, rpcKey, { debugLog: dbg });
    const tip = hexToNum(finHeader.result?.number || "0x0");
    const safeTip = Math.max(0, tip - minConf);

    // Force single tx (preko indexera)
    if (forceTx) {
      let inserted = 0;
      // Subscan detail endpoint: /api/scan/extrinsic (ili /api/scan/tx)
      // Ako nema key/indeksera, vratimo "graceful" poruku.
      if (!indexerPool.length) {
        const res = { chain: "dot", mode: "forceTx", tip, safeTip, tx: forceTx, inserted: 0, note: "Indexer not configured" };
        if (richDebug) (res as any).debugLog = dbg;
        return ok(res);
      }
      // pokušaj preko pool-a
      let matched: Array<{ to: string; amount: number; hash: string }> = [];
      for (const base of indexerPool) {
        const data = await postIndexer<any>(base, "/api/scan/extrinsic", { hash: forceTx }, subscanKey, dbg);
        const evtData = await postIndexer<any>(base, "/api/scan/extrinsic/events", { hash: forceTx }, subscanKey, dbg);
        const events: any[] = Array.isArray(evtData?.events) ? evtData.events : Array.isArray(evtData) ? evtData : [];
        matched = pickTransfersFromEvents(events).filter(m => addrSet.has(m.to));
        if (matched.length) break;
      }
      if (!matched.length) {
        const res = { chain: "dot", mode: "forceTx", tip, safeTip, tx: forceTx, outputsMatched: 0, inserted: 0 };
        if (richDebug) (res as any).debugLog = dbg;
        return ok(res);
      }

      const whenISO = new Date().toISOString(); // bez dodatnog poziva, transakcije su u finalized zoni
      for (const m of matched) {
        const wallet_id = addrToWallet.get(m.to)!;
        const { error: iErr } = await sb
          .from("contributions")
          .upsert([{ wallet_id, tx_hash: m.hash || forceTx, amount: m.amount, block_time: whenISO }], { onConflict: "tx_hash" })
          .select("tx_hash");
        if (iErr) throw iErr;
        inserted += 1;
      }
      const res = { chain: "dot", mode: "forceTx", tip, safeTip, tx: forceTx, outputsMatched: matched.length, inserted };
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
      const body: Json = { tip, safeTip, from, to, scanned: 0, inserted: 0, note: "Nothing to scan (waiting for finalization)" };
      if (richDebug) (body as any).debugLog = dbg;
      return ok(body);
    }

    // Ako nemamo nikakav indexer u poolu, nećemo failati — samo vratiti napomenu.
    if (!indexerPool.length) {
      const res = { chain: "dot", reason, tip, safeTip, from, to, scanned: 0, matched: 0, inserted: 0, note: "Indexer not configured" };
      if (richDebug) (res as any).debugLog = dbg;
      // spremi marker (da batch ne stoji u mjestu)
      await sb.from("settings").upsert({ key: CURSOR_KEY, value: { n: to } }, { onConflict: "key" });
      return ok(res);
    }

    // Scan blokove preko indexera (Subscan: /api/scan/events s {block_num})
    let scanned = 0;
    const rows: Array<{ wallet_id: string; tx_hash: string; amount: number; block_time: string }> = [];

    for (let h = from; h <= to; h++) {
      scanned++;
      let events: any[] = [];
      let blockTs: number | null = null;
      // probaj svaki indexer iz poola
      for (const base of indexerPool) {
        const evData = await postIndexer<any>(base, "/api/scan/events", { block_num: h }, subscanKey, dbg);
        const blkData = await postIndexer<any>(base, "/api/scan/block", { block_num: h }, subscanKey, dbg);
        const es: any[] = Array.isArray(evData?.events) ? evData.events : Array.isArray(evData) ? evData : [];
        events = es;
        blockTs = Number(blkData?.block?.block_timestamp || blkData?.timestamp || 0) || null;
        if (events.length) break;
      }
      if (!events.length) continue;

      const matches = pickTransfersFromEvents(events).filter(m => addrSet.has(m.to));
      if (!matches.length) continue;

      const whenISO = blockTs ? new Date(blockTs * 1000).toISOString() : new Date().toISOString();
      // agregiraj po (wallet_id, tx_hash)
      const agg = new Map<string, number>();
      for (const m of matches) {
        const wallet_id = addrToWallet.get(m.to)!;
        const key = `${wallet_id}::${m.hash}`;
        agg.set(key, (agg.get(key) || 0) + m.amount);
      }
      for (const [key, amount] of agg.entries()) {
        const [wallet_id, hash] = key.split("::");
        rows.push({ wallet_id, tx_hash: hash || `block_${h}`, amount, block_time: whenISO });
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
      chain: "dot",
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

