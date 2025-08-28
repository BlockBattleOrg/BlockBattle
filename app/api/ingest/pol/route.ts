// app/api/ingest/pol/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/**
 * POL (Polygon/PoS) native contributions ingest (EVM).
 * Scans blocks and records native transfers to our funding addresses into public.contributions.
 *
 * ENV required:
 *   - CRON_SECRET
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - POL_RPC_URL  (fallback: MATIC_RPC_URL, default: https://pol.nownodes.io)
 *   - NOWNODES_API_KEY
 *
 * Cursor in `public.settings`: key = "pol_contrib_last_scanned"
 */

type Json = Record<string, any>;
const ok  = (b: Json = {}) => NextResponse.json({ ok: true,  ...b });
const err = (m: string, status = 500, extra?: Json) =>
  NextResponse.json({ ok: false, error: m, ...(extra || {}) }, { status });

// Defaults tuned to be gentle on RPC
const RANGE      = Number(process.env.POL_SCAN_RANGE      || "250");  // blocks per run
const SAFETY_LAG = Number(process.env.POL_SAFETY_LAG      || "12");   // confirmations
const TIMEOUT_MS = Number(process.env.POL_HTTP_TIMEOUT_MS || "20000");
const RETRIES    = Number(process.env.POL_HTTP_RETRIES    || "2");

const CURSOR_KEY = "pol_contrib_last_scanned";

// ---------- helpers ----------
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

function rpcBase() {
  const u =
    (process.env.POL_RPC_URL || "").trim() ||
    (process.env.MATIC_RPC_URL || "").trim() ||
    "https://pol.nownodes.io";
  return u.replace(/\/+$/, "");
}
function rpcHeaders() {
  return { "Content-Type": "application/json", "api-key": need("NOWNODES_API_KEY") };
}

async function evmRpc<T = any>(method: string, params: any[], attempt = 0): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(rpcBase(), {
      method: "POST",
      headers: rpcHeaders(),
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const json = await res.json().catch(() => ({}));
    clearTimeout(timer);
    if (!res.ok || json.error) {
      if (attempt < RETRIES) {
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        return evmRpc<T>(method, params, attempt + 1);
      }
      throw new Error(`EVM RPC ${res.status} ${JSON.stringify(json.error || {})}`);
    }
    return json.result as T;
  } catch (e: any) {
    clearTimeout(timer);
    const msg = String(e?.message || e);
    if ((/abort|fetch failed/i).test(msg) && attempt < RETRIES) {
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      return evmRpc<T>(method, params, attempt + 1);
    }
    throw e;
  }
}

const hexToNum = (h: string) => parseInt(h.startsWith("0x") ? h.slice(2) : h, 16);
const toBN     = (h: string) => BigInt(h?.startsWith("0x") ? h : `0x${h || "0"}`);
const toAmount = (raw: bigint, decimals: number) => Number(raw) / 10 ** (Number.isFinite(decimals) ? decimals : 18);

// ---------- route ----------
export async function POST(req: Request) {
  try {
    // auth
    const expected = need("CRON_SECRET");
    if ((req.headers.get("x-cron-secret") || "") !== expected) return err("Unauthorized", 401);

    // env guard
    need("NOWNODES_API_KEY"); // rpcBase() has its own default if POL_RPC_URL/MATIC_RPC_URL missing

    const sb = supa();

    // 1) Load active POL/MATIC wallets (+ currency decimals)
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active,currencies(decimals)")
      .eq("is_active", true)
      .in("chain", ["pol", "matic"]); // treat matic alias if present
    if (wErr) throw wErr;

    const addrMap = new Map<
      string, // to-address (lowercase)
      { wallet_id: string; decimals: number }
    >();

    for (const w of wallets || []) {
      const address = String((w as any).address || "").toLowerCase();
      if (!address) continue;

      // SAFE read of decimals whether `currencies` is an object or an array
      const rel = (w as any).currencies;
      const cur = Array.isArray(rel) ? rel[0] : rel;
      const decimals = Number(cur?.decimals ?? 18) || 18;

      addrMap.set(address, { wallet_id: String((w as any).id), decimals });
    }
    if (!addrMap.size) {
      return ok({ chain: "POL", note: "No active POL/MATIC wallets", inserted: 0, scanned: 0 });
    }

    // 2) Determine scan range using cursor + safety lag
    const latestHex = await evmRpc<string>("eth_blockNumber", []);
    const tip       = hexToNum(latestHex);
    const safeTip   = Math.max(0, tip - SAFETY_LAG);

    const { data: st } = await sb.from("settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
    const prev = Number(st?.value?.n ?? 0);

    const from = prev > 0 ? prev + 1 : Math.max(0, safeTip - RANGE + 1);
    const to   = Math.min(safeTip, from + RANGE - 1);

    if (to < from) {
      return ok({ chain: "POL", tip, from, to, scanned: 0, inserted: 0, note: "Nothing to scan (waiting for confirmations)" });
    }

    // 3) Scan blocks and collect matches
    let scanned = 0;
    const candidates: Array<{ wallet_id: string; tx_hash: string; amount: number; amount_usd: number | null; block_time: string; }> = [];

    for (let h = from; h <= to; h++) {
      const blockHex = `0x${h.toString(16)}`;
      const block: any = await evmRpc("eth_getBlockByNumber", [blockHex, true]);
      scanned++;

      const ts = hexToNum(block?.timestamp || "0x0");
      const when = new Date((ts || 0) * 1000).toISOString();

      const txs: any[] = Array.isArray(block?.transactions) ? block.transactions : [];
      for (const tx of txs) {
        const toAddr = String(tx?.to || "").toLowerCase();
        if (!toAddr) continue;
        const hit = addrMap.get(toAddr);
        if (!hit) continue;

        const raw = toBN(String(tx?.value || "0x0"));
        if (raw <= 0n) continue;

        const amount = toAmount(raw, hit.decimals);
        candidates.push({
          wallet_id: hit.wallet_id,
          tx_hash: String(tx.hash),
          amount,
          amount_usd: null,
          block_time: when,
        });
      }
    }

    // 4) De-dupe per (tx_hash, wallet_id) and insert
    let existing = new Set<string>();
    if (candidates.length) {
      const uniq = Array.from(new Set(candidates.map(r => r.tx_hash)));
      const { data: ex } = await sb
        .from("contributions")
        .select("tx_hash,wallet_id")
        .in("tx_hash", uniq);
      existing = new Set((ex || []).map((e: any) => `${e.tx_hash}:${e.wallet_id}`));
    }

    const toInsert = candidates.filter(r => !existing.has(`${r.tx_hash}:${r.wallet_id}`));
    if (toInsert.length) {
      const { error: insErr } = await sb.from("contributions").insert(toInsert);
      if (insErr) throw insErr;
    }

    // 5) Save cursor
    await sb.from("settings").upsert({
      key: CURSOR_KEY,
      value: { n: to },
      updated_at: new Date().toISOString(),
    });

    return ok({
      chain: "POL",
      tip,
      from,
      to,
      scanned,
      candidates: candidates.length,
      inserted: toInsert.length,
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

