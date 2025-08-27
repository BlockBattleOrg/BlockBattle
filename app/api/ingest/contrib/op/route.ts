// app/api/ingest/contrib/op/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const RPC = (process.env.OP_RPC_URL || "").trim();
const KEY = (process.env.NOWNODES_API_KEY || "").trim();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

type Hex = string;

type EvmTx = {
  hash: string;
  to: string | null;
  value: Hex;
};

type EvmBlock = {
  number: Hex;
  timestamp: Hex;
  transactions: EvmTx[];
};

function toDec(hex?: string | null) {
  if (!hex) return 0;
  const s = hex.startsWith("0x") ? hex.slice(2) : hex;
  return s ? parseInt(s, 16) : 0;
}

async function rpc<T>(method: string, params: any[]): Promise<T> {
  if (!RPC) throw new Error("Missing OP_RPC_URL");
  if (!KEY) throw new Error("Missing NOWNODES_API_KEY");

  const res = await fetch(RPC, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": KEY,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`EVM RPC HTTP ${res.status} ${res.statusText}${txt ? `: ${txt}` : ""}`);
  }
  const json = (await res.json()) as any;
  if (json.error) throw new Error(String(json.error?.message || "RPC error"));
  return json.result as T;
}

// tolerant symbol/chain resolver (OP / OPTIMISM)
function isOP(symbol?: string | null, chain?: string | null) {
  const s = String(symbol || "").trim().toUpperCase();
  const c = String(chain || "").trim().toUpperCase();
  return s === "OP" || c === "OP" || c === "OPTIMISM";
}

// helpers for Supabase relation that may be object OR array
function relFirst<T = any>(maybe: any): T | undefined {
  if (!maybe) return undefined;
  return Array.isArray(maybe) ? maybe[0] : maybe;
}

export async function POST(req: Request) {
  try {
    // auth
    if (!CRON_SECRET) {
      return NextResponse.json({ ok: false, error: "Missing CRON_SECRET env" }, { status: 500 });
    }
    const hdr = req.headers.get("x-cron-secret") || "";
    if (hdr !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }

    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
    }
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // load active wallets; use explicit FK alias for clarity
    const { data: walletsAll, error: wErr } = await sb
      .from("wallets")
      .select(
        `
        id, address, chain, is_active, currency_id,
        currencies:currency_id ( symbol, decimals )
      `
      )
      .eq("is_active", true);

    if (wErr) throw wErr;

    const wallets = (walletsAll || []).filter((w: any) => {
      const cur = relFirst(w?.currencies);
      return w?.address && isOP(cur?.symbol, w?.chain);
    });

    if (wallets.length === 0) {
      return NextResponse.json({ ok: true, info: "No OP wallets active; nothing to ingest.", inserted: 0 });
    }

    // map address -> wallet_id/decimals (decimals default 18 for OP)
    const map = new Map<string, { wallet_id: string; decimals: number }>();
    for (const w of wallets) {
      const addr = String((w as any).address).toLowerCase();
      const cur = relFirst((w as any).currencies);
      const decimals = Number(cur?.decimals ?? 18) || 18;
      if (addr) map.set(addr, { wallet_id: (w as any).id, decimals });
    }

    // latest block
    const latestHex = await rpc<Hex>("eth_blockNumber", []);
    const latest = toDec(latestHex);

    // scan window (settings marker)
    const key = "op_contrib_last_scanned";
    const { data: sRow } = await sb.from("settings").select("value").eq("key", key).maybeSingle();
    const last = Number(sRow?.value?.n ?? NaN);
    const SPAN = 250;

    const startBase = Number.isFinite(last) ? last : Math.max(0, latest - SPAN);
    const from = Math.max(0, startBase + 1);
    const to = Math.min(latest, from + SPAN - 1);
    const scanned = to >= from ? to - from + 1 : 0;

    let matches: Array<{ wallet_id: string; hash: string; tsMs: number; amount: number }> = [];

    for (let n = from; n <= to; n++) {
      const bHex = "0x" + n.toString(16);
      const block = await rpc<EvmBlock>("eth_getBlockByNumber", [bHex, true]);
      if (!block) continue;
      const tsMs = toDec(block.timestamp) * 1000;

      for (const tx of block.transactions || []) {
        const toAddr = (tx.to || "").toLowerCase();
        if (!toAddr) continue;
        const info = map.get(toAddr);
        if (!info) continue;

        const raw = toDec(tx.value);
        if (!raw) continue;

        const amount = raw / Math.pow(10, info.decimals);
        matches.push({ wallet_id: info.wallet_id, hash: tx.hash, tsMs, amount });
      }
    }

    // de-dup by hash
    const hashes = Array.from(new Set(matches.map((m) => m.hash)));
    let existing = new Set<string>();
    if (hashes.length) {
      const { data: ex } = await sb.from("contributions").select("tx_hash").in("tx_hash", hashes);
      existing = new Set((ex || []).map((r: any) => String(r.tx_hash)));
    }

    const rows = matches
      .filter((m) => !existing.has(m.hash))
      .map((m) => ({
        wallet_id: m.wallet_id,
        tx_hash: m.hash,
        amount: m.amount,
        block_time: new Date(m.tsMs).toISOString(),
      }));

    if (rows.length) {
      const { error: insErr } = await sb.from("contributions").insert(rows);
      if (insErr) throw insErr;
    }

    // advance marker
    await sb.from("settings").upsert({ key, value: { n: to } }, { onConflict: "key" });

    return NextResponse.json({
      ok: true,
      chain: "OP",
      latest,
      from,
      to,
      scanned,
      found: matches.length,
      inserted: rows.length,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "OP contrib ingest failed" }, { status: 500 });
  }
}

