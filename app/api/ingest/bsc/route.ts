// app/api/ingest/bsc/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type Json = Record<string, any>;

const ok  = (b: Json = {}) => NextResponse.json({ ok: true,  ...b });
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

// NowNodes EVM RPC helper
function rpcBase() {
  return (process.env.BSC_RPC_URL || "").trim().replace(/\/+$/, "");
}
function rpcHeaders() {
  return {
    "Content-Type": "application/json",
    "api-key": need("NOWNODES_API_KEY"),
  };
}
async function evmRpc<T = any>(method: string, params: any[]): Promise<T> {
  const res = await fetch(rpcBase(), {
    method: "POST",
    headers: rpcHeaders(),
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    cache: "no-store",
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    throw new Error(`EVM RPC ${res.status} ${JSON.stringify(j.error || {})}`);
  }
  return j.result as T;
}

const hexToNum = (h: string) => parseInt(h.startsWith("0x") ? h.slice(2) : h, 16);

export async function POST(req: Request) {
  try {
    // auth
    const expected = need("CRON_SECRET");
    if ((req.headers.get("x-cron-secret") || "") !== expected) {
      return err("Unauthorized", 401);
    }

    // env guard
    need("BSC_RPC_URL");
    need("NOWNODES_API_KEY");

    const sb = supa();

    // latest block
    const latestHex = await evmRpc<string>("eth_blockNumber", []);
    const height = hexToNum(latestHex);

    // persist (heights_daily + settings)
    const today = new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();

    // upsert daily height
    {
      const { error } = await sb.from("heights_daily").upsert({
        day: today,
        chain: "BSC",
        height,
        updated_at: nowIso,
      });
      if (error) throw error;
    }

    // save last height cursor
    {
      const { error } = await sb.from("settings").upsert({
        key: "bsc_last_height",
        value: { n: height },
        updated_at: nowIso,
      });
      if (error) throw error;
    }

    return ok({ chain: "BSC", height, saved: true });
  } catch (e: any) {
    return err(e?.message || String(e), 500);
  }
}

