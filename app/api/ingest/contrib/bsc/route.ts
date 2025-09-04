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
function rpcUrl(): string {
  // Support multiple env names; first match wins
  return (
    maybe("BSC_RPC_URL") ||
    maybe("BSC_RPC") ||
    maybe("BNB_RPC_URL") ||
    maybe("BNB_RPC") ||
    need("BSC_RPC_URL") // will throw if all above missing
  );
}

async function evmRpc<T = any>(method: string, params: any[]): Promise<T> {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method} error: ${j.error?.message || j.error}`);
  return j.result as T;
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

    // Load funding wallets for BNB chain (normalize aliases)
    const { data: wallets, error: werr } = await db.from("wallets").select("id,address,chain");
    if (werr) throw new Error(`wallets: ${werr.message}`);

    const fundingMap = new Map<string, { id: string }>(); // address(lower) -> wallet meta
    for (const w of wallets || []) {
      const chain = canonChain((w as any).chain);
      if (chain === "BNB") {
        const addr = toLower((w as any).address);
        if (addr) fundingMap.set(addr as string, { id: String((w as any).id) });
      }
    }
    const funding = Array.from(fundingMap.keys());
    if (funding.length === 0) {
      return NextResponse.json({ ok: false, error: "No funding wallets for BNB" }, { status: 200 });
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
    const tip = hexToNum(await evmRpc<Hex>("eth_blockNumber", []));
    const safeTip = Math.max(0, tip - minConf);

    // ForceTx mode
    if (txHash) {
      const tx = await evmRpc<RpcTx | null>("eth_getTransactionByHash", [txHash]);
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
      const receipt = await evmRpc<RpcReceipt>("eth_getTransactionReceipt", [txHash]);
      if (receipt?.status !== "0x1") {
        return NextResponse.json({ ok: true, chain: "BSC", reason: "forceTx-reverted", inserted: 0 }, { status: 200 });
      }
      const block = await evmRpc<RpcBlock>("eth_getBlockByNumber", ["0x" + bn.toString(16), false]);
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

      return NextResponse.json({
        ok: true,
        chain: "BSC",
        inserted: 1,
        reason: "forceTx",
        tx: tx.hash,
        wallet_id: walletId,
        funding,
      });
    }

    // Range scan mode
    let fromBlock: number | null = null;
    if (sinceBlockParam) {
      const n = Number(sinceBlockParam);
      if (Number.isFinite(n) && n >= 0) fromBlock = n;
    }
    if (fromBlock === null && sinceHoursParam) {
      // approximate: BSC ~ 3s block -> ~1200 blocks/hour; cap with MAX_LOOKBACK
      const hours = Math.max(1, Number(sinceHoursParam));
      const approxBlocks = Math.min(MAX_LOOKBACK, Math.floor(hours * 1200));
      fromBlock = Math.max(0, safeTip - approxBlocks);
    }
    if (fromBlock === null) {
      const last = await getLastScanned(db);
      if (last && last > 0) fromBlock = Math.max(0, last - overlap);
    }
    if (fromBlock === null) fromBlock = Math.max(0, safeTip - 1000);

    const toLimit = maxBlocks > 0 ? Math.min(safeTip, fromBlock + maxBlocks) : safeTip;
    let cursor = fromBlock;
    let inserted = 0;
    let scanned = 0;
    const lastSeen = (await getLastScanned(db)) ?? 0;

    while (cursor <= toLimit) {
      const end = Math.min(cursor + BATCH_BLOCKS - 1, toLimit);

      // fetch blocks in parallel
      const blocks: RpcBlock[] = await Promise.all(
        Array.from({ length: end - cursor + 1 }, (_, i) => cursor + i).map((b) =>
          evmRpc<RpcBlock>("eth_getBlockByNumber", ["0x" + b.toString(16), true])
        )
      );

      scanned += blocks.length;

      // build candidate inserts
      const puts: { wallet_id: string; tx_hash: string; amount: number; block_time: string }[] = [];

      for (const blk of blocks) {
        const ts = hexToNum(blk.timestamp) * 1000;
        for (const tx of blk.transactions || []) {
          const to = toLower(tx.to);
          if (!to || !fundingMap.has(to)) continue;
          if (!tx.value || tx.value === "0x0") continue;

          // check success (filter only funding matches to minimize RPC)
          const rc = await evmRpc<RpcReceipt>("eth_getTransactionReceipt", [tx.hash]);
          if (rc?.status !== "0x1") continue;

          puts.push({
            wallet_id: fundingMap.get(to)!.id,
            tx_hash: tx.hash,
            amount: weiToEth(tx.value),
            block_time: new Date(ts).toISOString(),
          });
        }
      }

      if (puts.length) {
        const { error: ierr } = await db
          .from("contributions")
          .upsert(puts, { onConflict: "wallet_id,tx_hash" });
        if (ierr) throw new Error(`upsert chunk failed: ${ierr.message}`);
        inserted += puts.length;
      }

      cursor = end + 1;
      await setLastScanned(db, end);
    }

    return NextResponse.json({
      ok: true,
      chain: "BSC",
      tip: tip,
      from: fromBlock,
      to: toLimit,
      scanned,
      inserted,
      lastSeen,
      reason: sinceBlockParam ? "sinceBlock" : sinceHoursParam ? "sinceHours" : "markerScan",
      overlap,
      minConf,
      funding,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

