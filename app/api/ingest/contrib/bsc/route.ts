// app/api/ingest/contrib/bsc/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

/**
 * BSC (BNB Smart Chain) native contributions ingest.
 * - EVM-style scan of blocks and transactions
 * - Looks for transfers where tx.to == one of our funding addresses (lowercased)
 * - Writes into public.contributions (wallet_id, tx_hash, amount, block_time)
 *
 * ENV required:
 *   - CRON_SECRET
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - BSC_RPC_URL               (e.g. https://bsc.nownodes.io)
 *   - NOWNODES_API_KEY
 */

type Json = Record<string, any>;
const ok  = (b: Json = {}) => NextResponse.json({ ok: true,  ...b });
const err = (m: string, status = 500, extra?: Json) =>
  NextResponse.json({ ok: false, error: m, ...(extra || {}) }, { status });

// BSC native coin has 18 decimals
const DECIMALS = 18;

// Scan tuning (conservative defaults to avoid timeouts)
const RANGE      = Number(process.env.BSC_SCAN_RANGE      || "250");   // blocks per run
const SAFETY_LAG = Number(process.env.BSC_SAFETY_LAG      || "12");    // confirmations
const TIMEOUT_MS = Number(process.env.BSC_HTTP_TIMEOUT_MS || "20000");
const RETRIES    = Number(process.env.BSC_HTTP_RETRIES    || "2");

// settings key (cursor)
const CURSOR_KEY = "bsc_contrib_last_scanned";

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
  return (process.env.BSC_RPC_URL || "").trim().replace(/\/+$/, "");
}
function rpcHeaders() {
  return { "Content-Type": "application/json", "api-key": need("NOWNODES_API_KEY") };
}

async function evmRpc<T=any>(method: string, params: any[], attempt = 0): Promise<T> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(rpcBase(), {
      method: "POST",
      headers: rpcHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const j = await res.json().catch(() => ({}));
    clearTimeout(t);
    if (!res.ok || j.error) {
      if (attempt < RETRIES) {
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
        return evmRpc<T>(method, params, attempt + 1);
      }
      throw new Error(`EVM RPC ${res.status} ${JSON.stringify(j.error || {})}`);
    }
    return j.result as T;
  } catch (e: any) {
    clearTimeout(t);
    const msg = String(e?.message || e);
    if ((/abort|fetch failed/i).test(msg) && attempt < RETRIES) {
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      return evmRpc<T>(method, params, attempt + 1);
    }
    throw e;
  }
}

const hexToNum = (h: string) => parseInt(h.startsWith("0x") ? h.slice(2) : h, 16);
const toBN     = (h: string) => BigInt(h.startsWith("0x") ? h : `0x${h}`);
const toAmount = (wei: bigint) => Number(wei) / 10 ** DECIMALS;

export async function POST(req: Request) {
  try {
    // Auth
    const expected = need("CRON_SECRET");
    if ((req.headers.get("x-cron-secret") || "") !== expected) {
      return err("Unauthorized", 401);
    }

    // Env checks
    need("BSC_RPC_URL");
    need("NOWNODES_API_KEY");

    const sb = supa();

    // 1) Load active BSC wallets
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select("id,address,chain,is_active")
      .eq("is_active", true)
      .eq("chain", "bsc");
    if (wErr) throw wErr;
    const addrs = (wallets || [])
      .map(w => ({ id: String(w.id), addr: String(w.address || "").toLowerCase() }))
      .filter(w => !!w.addr);

    if (!addrs.length) {
      return ok({ note: "No active BSC wallets", inserted: 0, scanned: 0 });
    }
    const addrMap = new Map<string, string>(); // to -> wallet_id
    for (const w of addrs) addrMap.set(w.addr, w.id);

    // 2) Determine scan range
    const latestHex = await evmRpc<string>("eth_blockNumber", []);
    const tip       = hexToNum(latestHex);
    const maxTo     = Math.max(0, tip - SAFETY_LAG);

    const { data: st } = await sb.from("settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
    const prev = Number(st?.value?.n ?? 0);

    const from = prev > 0 ? prev + 1 : Math.max(0, maxTo - RANGE + 1);
    const to   = Math.min(maxTo, from + RANGE - 1);
    if (to < from) {
      return ok({ tip, from, to, scanned: 0, inserted: 0, note: "Nothing to scan (waiting for confirmations)" });
    }

    // 3) Scan blocks and collect matches
    const rows: Array<{ wallet_id: string; tx_hash: string; amount: number; amount_usd: number | null; block_time: string; }> = [];
    let scanned = 0;

    for (let h = from; h <= to; h++) {
      const blockHex = `0x${h.toString(16)}`;
      const block = await evmRpc<any>("eth_getBlockByNumber", [blockHex, true]);
      scanned++;

      const timestamp = hexToNum(block?.timestamp || "0x0");
      const whenISO = new Date(timestamp * 1000).toISOString();
      const txs: any[] = Array.isArray(block?.transactions) ? block.transactions : [];

      for (const tx of txs) {
        const toAddr = String(tx?.to || "").toLowerCase();
        if (!toAddr) continue;

        const walletId = addrMap.get(toAddr);
        if (!walletId) continue;

        const value = toBN(String(tx?.value || "0x0"));
        if (value <= 0n) continue;

        rows.push({
          wallet_id: walletId,
          tx_hash: String(tx.hash),
          amount: toAmount(value),
          amount_usd: null,
          block_time: whenISO,
        });
      }
    }

    // 4) De-dupe and insert
    let existing = new Set<string>();
    if (rows.length) {
      const uniq = Array.from(new Set(rows.map(r => r.tx_hash)));
      const { data: ex } = await sb
        .from("contributions")
        .select("tx_hash,wallet_id")
        .in("tx_hash", uniq);
      existing = new Set((ex || []).map((e: any) => `${e.tx_hash}:${e.wallet_id}`));
    }

    const toInsert = rows.filter(r => !existing.has(`${r.tx_hash}:${r.wallet_id}`));
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
      chain: "BSC",
      tip,
      from,
      to,
      scanned,
      candidates: rows.length,
      inserted: toInsert.length,
    });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

