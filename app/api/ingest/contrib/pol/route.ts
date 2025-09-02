// app/api/ingest/contrib/pol/route.ts
import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Hex = `0x${string}`;
type Address = `0x${string}`;

const BATCH_BLOCKS = 250;
const MAX_LOOKBACK = 5000; // safety cap for sinceHours lookback

// ---------- Utils ----------
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ENV: ${name}`);
  return v;
}
function rpcBase(): string {
  const u =
    (process.env.POL_RPC_URL || "").trim() ||
    (process.env.MATIC_RPC_URL || "").trim() ||
    "https://pol.nownodes.io";
  return u.replace(/\/+$/, "");
}
function rpcHeaders() {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env.NOWNODES_API_KEY;
  if (key) headers["api-key"] = key; // NowNodes needs api-key
  return headers;
}
async function evmRpc<T = any>(method: string, params: any[], attempt = 0): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(rpcBase(), { method: "POST", headers: rpcHeaders(), body });
  if (!res.ok) {
    if (attempt < 2) return evmRpc<T>(method, params, attempt + 1);
    throw new Error(`RPC ${method} failed: HTTP ${res.status}`);
  }
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method} error: ${j.error?.message || j.error}`);
  return j.result as T;
}
const toBig = (x: Hex | string | null | undefined) => BigInt(x ?? "0x0");
const hexToInt = (x: Hex | string) => Number(BigInt(x as any));
function weiToDecimalString(wei: Hex | string, decimals = 18): string {
  const v = toBig(wei);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return whole.toString();
  const f = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${f}`;
}
function weiToNumber(wei: Hex | string, decimals = 18): number {
  return Number(weiToDecimalString(wei, decimals));
}
function isAddress(x: any): x is Address {
  return typeof x === "string" && /^0x[a-fA-F0-9]{40}$/.test(x);
}
const lc = (x: string | null | undefined) => (x || "").toLowerCase();

// ---------- Supabase ----------
function supa(): SupabaseClient {
  return createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

type WalletRow = { id: string; address: string; chain: string };

async function getPolygonWallets(client: SupabaseClient): Promise<{ byAddr: Map<string, WalletRow>; list: WalletRow[] }> {
  const { data, error } = await client
    .from("wallets")
    .select("id,address,chain")
    .in("chain", ["pol", "matic", "polygon"])
    .order("address");
  if (error) throw new Error(`Supabase wallets: ${error.message}`);
  const list: WalletRow[] = (data || []).filter((w: any) => isAddress(w.address));
  const byAddr = new Map<string, WalletRow>();
  for (const w of list) byAddr.set(lc(w.address), w);
  return { byAddr, list };
}

async function getLastScanned(client: SupabaseClient): Promise<number | null> {
  const { data, error } = await client
    .from("settings")
    .select("key,value")
    .eq("key", "pol_contrib_last_scanned")
    .maybeSingle();
  if (error) throw new Error(`Supabase settings: ${error.message}`);
  const v = data?.value ? Number(data.value) : null;
  return Number.isFinite(v as any) ? (v as number) : null;
}
async function setLastScanned(client: SupabaseClient, value: number): Promise<void> {
  const { error } = await client
    .from("settings")
    .upsert([{ key: "pol_contrib_last_scanned", value: String(value) }], { onConflict: "key" });
  if (error) throw new Error(`Supabase settings upsert: ${error.message}`);
}

// ---------- RPC Types ----------
interface RpcTx {
  hash: Hex;
  from?: Address;
  to?: Address | null;
  value: Hex;
  blockNumber: Hex;
}
interface RpcBlock {
  number: Hex;
  timestamp: Hex;
  transactions: RpcTx[];
}

// ---------- Handler ----------
export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const secret = req.headers.get("x-cron-secret") || "";
    if (secret !== need("CRON_SECRET")) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const client = supa();
    const debug = url.searchParams.get("debug") === "1";
    const sinceHours = Number(url.searchParams.get("sinceHours") || "0");
    const sinceBlockParam = url.searchParams.get("sinceBlock");
    const maxBlocks = Math.min(Number(url.searchParams.get("maxBlocks") || "0") || 0, 20000) || 0;
    const forceTx = url.searchParams.get("tx"); // direct single-tx debug path
    // temporary helper to compute amount_usd directly in-route until FX normalizer fills it
    const usdPerPol = Number(url.searchParams.get("usdPerPol") || "0");
    const useUsd = Number.isFinite(usdPerPol) && usdPerPol > 0 ? usdPerPol : 0;

    const tipHex = await evmRpc<Hex>("eth_blockNumber", []);
    const tip = hexToInt(tipHex);

    const { byAddr, list: wallets } = await getPolygonWallets(client);
    if (wallets.length === 0) {
      return NextResponse.json({ ok: false, error: "No Polygon wallets configured (chain in pol/matic/polygon)" }, { status: 500 });
    }

    // ---------- Direct TX path ----------
    if (forceTx) {
      const tx = await evmRpc<RpcTx>("eth_getTransactionByHash", [forceTx]);
      if (!tx) return NextResponse.json({ ok: false, error: "tx not found" }, { status: 404 });

      const to = lc(tx.to || "");
      const hit = to && byAddr.get(to);
      if (!hit || toBig(tx.value) === 0n) {
        return NextResponse.json({ ok: false, error: "tx is not a native POL transfer to our wallet" }, { status: 200 });
      }

      const blk = hexToInt(tx.blockNumber);
      const blkData = await evmRpc<RpcBlock>("eth_getBlockByNumber", [tx.blockNumber, false]);
      const ts = hexToInt((blkData as any).timestamp as Hex);

      const amount = weiToDecimalString(tx.value); // store as NUMERIC via text
      const amount_usd = useUsd ? weiToNumber(tx.value) * useUsd : null;

      // idempotent insert on (wallet_id, tx_hash)
      const { error } = await client
        .from("contributions")
        .upsert(
          [
            {
              wallet_id: hit.id,
              tx_hash: tx.hash,
              amount,          // NUMERIC
              amount_usd,      // NUMERIC | null
              block_time: new Date(ts * 1000).toISOString(),
            },
          ],
          { onConflict: "wallet_id,tx_hash", ignoreDuplicates: true }
        );

      if (error) return NextResponse.json({ ok: false, error: `insert failed: ${error.message}` }, { status: 500 });

      await setLastScanned(client, Math.max((await getLastScanned(client)) || 0, blk));

      const resp: any = { ok: true, inserted: 1, reason: "forceTx", tx: tx.hash, wallet_id: hit.id };
      if (useUsd) resp.usdPerPol = useUsd;
      if (debug) resp.funding = wallets.map(w => w.address.toLowerCase());
      return NextResponse.json(resp);
    }

    // ---------- Range scan ----------
    let fromBlock: number | null = null;
    if (sinceBlockParam) {
      const n = Number(sinceBlockParam);
      if (!Number.isFinite(n) || n < 0) {
        return NextResponse.json({ ok: false, error: "sinceBlock must be a positive integer" }, { status: 400 });
      }
      fromBlock = n;
    } else if (sinceHours > 0) {
      // Polygon ~2s per block → ~1800 blocks/hour
      const approx = Math.min(MAX_LOOKBACK, sinceHours * 1800);
      fromBlock = Math.max(0, tip - approx);
    } else {
      fromBlock = (await getLastScanned(client)) ?? null;
      if (fromBlock !== null) fromBlock = Math.min(fromBlock + 1, tip);
    }
    if (fromBlock === null) fromBlock = Math.max(0, tip - 1000);

    const limitTo = maxBlocks > 0 ? Math.min(tip, fromBlock + maxBlocks) : tip;
    let cursor = fromBlock;
    let inserted = 0;
    let scannedBlocks = 0;
    let lastSeen = (await getLastScanned(client)) ?? 0;

    while (cursor <= limitTo) {
      const toBlock = Math.min(cursor + BATCH_BLOCKS - 1, limitTo);

      // fetch blocks with full txs
      const blockPromises: Promise<RpcBlock>[] = [];
      for (let b = cursor; b <= toBlock; b++) {
        blockPromises.push(evmRpc<RpcBlock>("eth_getBlockByNumber", ["0x" + b.toString(16), true]));
      }
      const blocks = await Promise.all(blockPromises);
      scannedBlocks += blocks.length;

      const rows: any[] = [];

      for (const blk of blocks) {
        const bn = hexToInt(blk.number);
        const ts = hexToInt(blk.timestamp);
        for (const tx of blk.transactions || []) {
          const to = lc(tx.to || "");
          const hit = to && byAddr.get(to);
          if (hit && toBig(tx.value) > 0n) {
            const amount = weiToDecimalString(tx.value);
            const amount_usd = useUsd ? weiToNumber(tx.value) * useUsd : null;

            rows.push({
              wallet_id: hit.id,
              tx_hash: tx.hash,
              amount,
              amount_usd,
              block_time: new Date(ts * 1000).toISOString(),
            });
          }
        }
        lastSeen = Math.max(lastSeen, bn);
      }

      if (rows.length) {
        // upsert to avoid unique violation on reruns
        const { error } = await client
          .from("contributions")
          .upsert(rows, { onConflict: "wallet_id,tx_hash", ignoreDuplicates: true });
        if (error) throw new Error(`insert failed: ${error.message}`);
        inserted += rows.length;
      }

      await setLastScanned(client, toBlock);
      cursor = toBlock + 1;

      if (!maxBlocks) break; // one batch per run if maxBlocks not specified
    }

    const resp: any = {
      ok: true,
      tip,
      from: fromBlock,
      to: Math.min(limitTo, fromBlock + BATCH_BLOCKS - 1),
      scanned: scannedBlocks,
      inserted,
      lastSeen,
      reason: sinceBlockParam ? "sinceBlock" : sinceHours ? "sinceHours" : "marker",
    };
    if (useUsd) resp.usdPerPol = useUsd;
    if (debug) resp.funding = wallets.map(w => w.address.toLowerCase());
    return NextResponse.json(resp);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

