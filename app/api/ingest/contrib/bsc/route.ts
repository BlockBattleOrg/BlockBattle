// app/api/ingest/contrib/bsc/route.ts
import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { canonChain } from "@/lib/chain";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Hex = `0x${string}`;
type Address = `0x${string}`;

const BATCH_BLOCKS = 250;
const MAX_LOOKBACK = 5000; // safety cap for sinceHours->blocks

// ---------- Utils ----------
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ENV: ${name}`);
  return v;
}
function maybe(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length ? v : undefined;
}
function supa(): SupabaseClient {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    "";
  if (!url || !key) throw new Error("Missing Supabase env (URL/KEY)");
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Build RPC URL pool:
 * - BSC_RPC_POOL (comma-separated)
 * - else BSC_RPC_URL / BSC_RPC / BNB_RPC_URL / BNB_RPC
 * If host includes "nownodes.io" and we have NOWNODES_API_KEY, also add query param variants
 * (?apikey, ?api_key, ?apiKey) as fallbacks.
 */
function getRpcPool(): string[] {
  const pool = (maybe("BSC_RPC_POOL") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const base =
    pool.length > 0
      ? pool
      : [
          maybe("BSC_RPC_URL"),
          maybe("BSC_RPC"),
          maybe("BNB_RPC_URL"),
          maybe("BNB_RPC"),
        ].filter(Boolean) as string[];

  if (base.length === 0) {
    throw new Error("No BSC RPC env set (BSC_RPC_POOL/BSC_RPC_URL/BSC_RPC/BNB_RPC_URL/BNB_RPC)");
  }

  const key = maybe("NOWNODES_API_KEY");
  const variants: string[] = [];
  for (const url of base) {
    variants.push(url);
    try {
      const u = new URL(url);
      if (key && u.hostname.includes("nownodes.io")) {
        const names = ["apikey", "api_key", "apiKey"];
        for (const pname of names) {
          const v = new URL(url);
          v.searchParams.set(pname, key);
          variants.push(v.toString());
        }
      }
    } catch {
      // ignore invalid URL parse, keep raw
    }
  }
  return Array.from(new Set(variants));
}

/** Try multiple header key variants commonly seen with NowNodes-style APIs. */
function buildHeaderVariants(): Record<string, string>[] {
  const base: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const key = maybe("NOWNODES_API_KEY");
  const variants: Record<string, string>[] = [base];
  if (key) {
    variants.push({ ...base, "api-key": key });
    variants.push({ ...base, "x-api-key": key });
    variants.push({ ...base, "X-API-KEY": key });
    // Some setups expect Bearer format:
    variants.push({ ...base, Authorization: `Bearer ${key}` });
  }
  return variants;
}

async function evmRpc<T = any>(
  method: string,
  params: any[],
  debug = false
): Promise<{ result: T; urlUsed: string; headersUsed: Record<string, string> }> {
  const urls = getRpcPool();
  const headerVariants = buildHeaderVariants();
  const errors: string[] = [];

  for (const url of urls) {
    for (const headers of headerVariants) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const raw = await res.text().catch(() => "");
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}${raw ? `: ${raw.slice(0, 200)}` : ""}`);
        }
        let j: any;
        try {
          j = JSON.parse(raw);
        } catch {
          throw new Error(`Non-JSON (first 200): ${raw.slice(0, 200)}`);
        }
        if (j.error) {
          throw new Error(j.error?.message || JSON.stringify(j.error));
        }
        return { result: j.result as T, urlUsed: url, headersUsed: headers };
      } catch (e: any) {
        errors.push(`${method} @ ${url} ${JSON.stringify(headers)} -> ${e?.message || e}`);
      }
    }
  }
  const msg = debug ? `RPC ${method} failed:\n${errors.join("\n")}` : `RPC ${method} failed`;
  throw new Error(msg);
}

function hexToNum(hex: Hex | string | null | undefined): number {
  if (!hex) return 0;
  return Number(BigInt(hex as string));
}
function weiToEth(v: Hex | string): number {
  const n = typeof v === "string" && v.startsWith("0x") ? Number(BigInt(v)) : Number(v);
  return n / 1e18;
}
function toLower(addr?: string | null): string {
  return (addr || "").toLowerCase();
}

async function getLastScanned(db: SupabaseClient): Promise<number | null> {
  const key = "bsc_contrib_last_scanned";
  const { data, error } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  if (error) return null;
  if (data?.value == null) return null;
  const v = Number(data.value);
  return Number.isFinite(v) ? v : null;
}
async function setLastScanned(db: SupabaseClient, height: number): Promise<void> {
  const key = "bsc_contrib_last_scanned";
  await db.from("settings").upsert({ key, value: String(height) }, { onConflict: "key" });
}

// ---------- Types from RPC ----------
type RpcTx = {
  hash: Hex;
  to: Address | null;
  from: Address;
  value: Hex;
  blockNumber: Hex | null;
};
type RpcBlock = {
  number: Hex;
  timestamp: Hex;
  transactions: RpcTx[];
};
type RpcReceipt = { status?: Hex; to?: Address | null; from?: Address; contractAddress?: Address | null };

// ---------- Main handler ----------
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const secret = req.headers.get("x-cron-secret") || "";
    if (secret !== need("CRON_SECRET")) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const db = supa();

    // Load funding wallets for BSC chain (normalize aliases)
    const { data: wallets, error: werr } = await db.from("wallets").select("id,address,chain");
    if (werr) throw new Error(`wallets: ${werr.message}`);

    const fundingMap = new Map<string, { id: string }>(); // address(lower) -> wallet meta
    for (const w of wallets || []) {
      const chain = canonChain((w as any).chain);
      // canonical slug for Binance Smart Chain is "bsc" (aliases: bnb/bsc)
      if (chain === "bsc") {
        const addr = toLower((w as any).address);
        if (addr) fundingMap.set(addr as string, { id: String((w as any).id) });
      }
    }
    const funding = Array.from(fundingMap.keys());
    if (funding.length === 0) {
      return NextResponse.json({ ok: false, error: "No funding wallets for BSC" }, { status: 200 });
    }

    // Params
    const debug = url.searchParams.get("debug") === "1";
    const txHash = (url.searchParams.get("tx") || "").trim() as Hex | "";
    const minConf = Math.max(0, Number(url.searchParams.get("minConf") || "4"));
    const overlap = Math.max(0, Number(url.searchParams.get("overlap") || "200"));
    const sinceBlockParam = url.searchParams.get("sinceBlock");
    const sinceHoursParam = url.searchParams.get("sinceHours");
    const maxBlocks = Math.max(0, Number(url.searchParams.get("maxBlocks") || "5000"));

    // Tip and safe head
    const { result: tipHex, urlUsed: tipUrl, headersUsed } = await evmRpc<Hex>("eth_blockNumber", [], debug);
    const tip = hexToNum(tipHex);
    const safeTip = Math.max(0, tip - minConf);

    // ForceTx mode
    if (txHash) {
      const { result: tx } = await evmRpc<RpcTx | null>("eth_getTransactionByHash", [txHash], debug);
      if (!tx || !tx.blockNumber) {
        return NextResponse.json({ ok: false, chain: "BSC", error: "tx not found or not yet mined" }, { status: 200 });
        }
      const toAddr = toLower(tx.to);
      if (!toAddr || !fundingMap.has(toAddr)) {
        return NextResponse.json({ ok: true, chain: "BSC", reason: "forceTx-nonFunding", inserted: 0, funding }, { status: 200 });
      }
      const bn = hexToNum(tx.blockNumber);
      if (bn > safeTip) {
        return NextResponse.json({ ok: false, chain: "BSC", error: `tx block ${bn} < min confirmations` }, { status: 200 });
      }
      const { result: receipt } = await evmRpc<RpcReceipt>("eth_getTransactionReceipt", [txHash], debug);
      if (receipt?.status !== "0x1") {
        return NextResponse.json({ ok: true, chain: "BSC", reason: "forceTx-reverted", inserted: 0 }, { status: 200 });
      }
      const { result: block } = await evmRpc<RpcBlock>("eth_getBlockByNumber", ["0x" + bn.toString(16), false], debug);
      const ts = hexToNum(block?.timestamp || "0x0") * 1000;
      const amount = weiToEth(tx.value);
      const walletId = fundingMap.get(toAddr)!.id;

      const { error: ierr } = await db
        .from("contributions")
        .upsert(
          [{ wallet_id: walletId, tx_hash: tx.hash, amount: amount, block_time: new Date(ts).toISOString() }],
          { onConflict: "wallet_id,tx_hash" }
        );
      if (ierr) throw new Error(`insert failed: ${ierr.message}`);

      return Next

