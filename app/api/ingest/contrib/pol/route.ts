// app/api/ingest/contrib/pol/route.ts
import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Hex = `0x${string}`;
type Address = `0x${string}`;

const BATCH_BLOCKS = 250;
const MAX_LOOKBACK = 5000; // hard cap for override lookbacks

// ---------- Helpers ----------
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
  // For NowNodes we pass an api-key; for other providers header may be ignored.
  const key = process.env.NOWNODES_API_KEY;
  if (key) headers["api-key"] = key;
  return headers;
}
async function evmRpc<T = any>(method: string, params: any[], attempt = 0): Promise<T> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(`${rpcBase()}`, { method: "POST", headers: rpcHeaders(), body });
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
function weiToDecimal(wei: Hex | string, decimals = 18): string {
  const v = toBig(wei);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  if (frac === 0n) return whole.toString();
  const f = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${f}`;
}
function isAddress(x: any): x is Address {
  return typeof x === "string" && /^0x[a-fA-F0-9]{40}$/.test(x);
}
function lc(x: string | null | undefined) {
  return (x || "").toLowerCase();
}

// ---------- Supabase ----------
function supa(): SupabaseClient {
  return createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

async function getFundingAddresses(client: SupabaseClient): Promise<Set<string>> {
  // Accept aliases while we keep both POL/MATIC around
  const { data, error } = await client
    .from("wallets")
    .select("address, chain, symbol")
    .in("symbol", ["POL", "MATIC"])
    .order("address");
  if (error) throw new Error(`Supabase wallets: ${error.message}`);
  const set = new Set<string>();
  for (const w of data || []) {
    if (isAddress(w.address)) set.add(lc(w.address));
  }
  return set;
}

async function getLastScanned(client: SupabaseClient): Promise<number | null> {
  const { data, error } = await client
    .from("settings")
    .select("key,value")
    .eq("key", "pol_contrib_last_scanned")
    .maybeSingle();
  if (error) throw new Error(`Supabase settings: ${error.message}`);
  const v = data?.value ? Number(data.value) : null;
  return isFinite(v as any) ? (v as number) : null;
}
async function setLastScanned(client: SupabaseClient, value: number): Promise<void> {
  const { error } = await client
    .from("settings")
    .upsert([{ key: "pol_contrib_last_scanned", value: value.toString() }], { onConflict: "key" });
  if (error) throw new Error(`Supabase settings upsert: ${error.message}`);
}

// ---------- Types from RPC ----------
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
interface TraceItem {
  action: { to?: Address; from?: Address; value?: string };
  type?: string;
  error?: string;
  result?: { gasUsed?: string };
  blockHash?: Hex;
  transactionHash?: Hex;
}

// ---------- Main handler ----------
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
    const forceTx = url.searchParams.get("tx"); // optional: directly check & insert this tx hash
    const traceInternal = (process.env.TRACE_INTERNAL || "").toLowerCase() === "true";

    const tipHex = await evmRpc<Hex>("eth_blockNumber", []);
    const tip = hexToInt(tipHex);

    const addrs = await getFundingAddresses(client);
    if (addrs.size === 0) {
      return NextResponse.json({ ok: false, error: "No funding addresses (POL) in wallets table" }, { status: 500 });
    }

    // Optional direct TX insert path (useful for debugging internal transfers)
    if (forceTx) {
      const tx = await evmRpc<RpcTx>("eth_getTransactionByHash", [forceTx]);
      if (!tx) return NextResponse.json({ ok: false, error: "tx not found" }, { status: 404 });
      const receipt = await evmRpc<any>("eth_getTransactionReceipt", [forceTx]);
      const blk = hexToInt(tx.blockNumber);
      const blkData = await evmRpc<RpcBlock>("eth_getBlockByNumber", [tx.blockNumber, false]);
      const ts = hexToInt((blkData as any).timestamp as Hex);
      const to = lc(tx.to || "");
      const from = lc(tx.from || "");
      const isDirect = addrs.has(to) && toBig(tx.value) > 0n;
      let captured = isDirect;
      // internal trace (optional)
      if (!captured && traceInternal) {
        const traces = await evmRpc<TraceItem[]>("trace_transaction", [forceTx]).catch(() => [] as TraceItem[]);
        for (const t of traces || []) {
          const v = BigInt(t.action?.value || "0x0");
          if (v > 0n && t.action?.to && addrs.has(lc(t.action.to))) {
            captured = true;
            break;
          }
        }
      }
      if (!captured) {
        return NextResponse.json({ ok: false, error: "tx does not transfer native POL to our address (direct or internal)" }, { status: 200 });
      }
      // insert
      const amount = isDirect ? weiToDecimal(tx.value) : weiToDecimal("0x0"); // native value comes from tx; for internal we'd fetch trace.value if we persisted it
      const { error } = await client.from("contributions").insert([{
        chain: "pol",
        symbol: "POL",
        from_address: from,
        to_address: isDirect ? to : null,
        tx_hash: tx.hash,
        block_number: blk,
        block_time: new Date(ts * 1000).toISOString(),
        amount_native: amount,
      }]);
      if (error) return NextResponse.json({ ok: false, error: `insert failed: ${error.message}` }, { status: 500 });
      await setLastScanned(client, Math.max((await getLastScanned(client)) || 0, blk));
      return NextResponse.json({ ok: true, inserted: 1, tx: tx.hash, block: blk, reason: "forceTx" });
    }

    // Determine starting block
    let fromBlock: number | null = null;
    if (sinceBlockParam) {
      fromBlock = Math.max(0, Number(sinceBlockParam));
    } else if (sinceHours > 0) {
      // Polygon ~ 2s block time → ~1800 blocks/hour
      const approx = Math.min(MAX_LOOKBACK, sinceHours * 1800);
      fromBlock = Math.max(0, tip - approx);
    } else {
      fromBlock = (await getLastScanned(client)) ?? null;
      if (fromBlock !== null) fromBlock = Math.min(fromBlock + 1, tip);
    }
    if (fromBlock === null) {
      fromBlock = Math.max(0, tip - 1000); // default bootstrap
    }

    const limitTo = maxBlocks > 0 ? Math.min(tip, fromBlock + maxBlocks) : tip;
    let cursor = fromBlock;
    let inserted = 0;
    let scanned = 0;
    let lastSeen = (await getLastScanned(client)) ?? 0;

    while (cursor <= limitTo) {
      const toBlock = Math.min(cursor + BATCH_BLOCKS - 1, limitTo);
      const blockPromises: Promise<RpcBlock>[] = [];
      for (let b = cursor; b <= toBlock; b++) {
        blockPromises.push(evmRpc<RpcBlock>("eth_getBlockByNumber", ["0x" + b.toString(16), true]));
      }
      const blocks = await Promise.all(blockPromises);
      scanned += blocks.length;

      type Candidate = {
        tx: RpcTx;
        block: number;
        timestamp: number;
      };
      const candidates: Candidate[] = [];

      for (const blk of blocks) {
        const bn = hexToInt(blk.number);
        const ts = hexToInt(blk.timestamp);
        for (const tx of blk.transactions) {
          // direct native transfer
          if (tx.to && addrs.has(lc(tx.to)) && toBig(tx.value) > 0n) {
            candidates.push({ tx, block: bn, timestamp: ts });
          }
        }
        lastSeen = Math.max(lastSeen, bn);
      }

      // (Optional) internal transfers – trace mode
      if (traceInternal) {
        const tracePromises: Promise<TraceItem[]>[] = [];
        for (let b = cursor; b <= toBlock; b++) {
          tracePromises.push(evmRpc<TraceItem[]>("trace_block", ["0x" + b.toString(16)]).catch(() => [] as TraceItem[]));
        }
        await Promise.all(tracePromises); // For sada samo “sniffamo”; insert radimo kroz forceTx kad treba
      }

      if (candidates.length > 0) {
        const rows = candidates.map((c) => ({
          chain: "pol",
          symbol: "POL",
          from_address: lc(c.tx.from || ""),
          to_address: lc(c.tx.to || ""),
          tx_hash: c.tx.hash,
          block_number: c.block,
          block_time: new Date(c.timestamp * 1000).toISOString(),
          amount_native: weiToDecimal(c.tx.value),
        }));
        const { error } = await client.from("contributions").insert(rows);
        if (error) throw new Error(`insert failed: ${error.message}`);
        inserted += rows.length;
      }

      await setLastScanned(client, toBlock);
      cursor = toBlock + 1;

      // Bez maxBlocks – ostajemo na jednom batchu (cron-friendly).
      if (!maxBlocks) break;
    }

    const resp: Record<string, any> = {
      ok: true,
      tip,
      from: fromBlock,
      to: Math.min(limitTo, fromBlock + BATCH_BLOCKS - 1),
      scanned,
      inserted,
      lastSeen,
      reason: sinceBlockParam ? "sinceBlock" : sinceHours ? "sinceHours" : "marker",
      overlapBlocks: 0,
      overrideLookback: sinceHours > 0 ? Math.min(MAX_LOOKBACK, sinceHours * 1800) : 0,
    };
    if (debug) resp.funding = Array.from(addrs);
    return NextResponse.json(resp);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

