// app/api/claim/route.ts
// Public claim proxy (single entrypoint used by /claim UI).
// Accepts { chain, tx, message, hcaptchaToken? } and forwards to
// /api/claim-ingest/:chain while preserving body (message -> note).
//
// Goals (non-breaking):
// - Keep current behavior for supported chains.
// - Add stricter-but-safe validation for EVM tx hashes only (others passthrough).
// - Normalize common chain aliases (e.g., matic|polygon -> pol, bnb -> bsc).
// - Return uniform JSON with { ok, code, message, ... } and HTTP 200, no-store.
//
// This proxy **does not** write to DB; idempotency and existence checks
// happen inside the chain-specific claim-ingest routes.
//
// Notes:
// - All caching disabled (dynamic + no-store) to avoid UI confusion.
// - Uses CRON_SECRET to authenticate downstream internal route.
//
// Example request body:
//   { "chain": "pol", "tx": "0xabc...", "message": "Your note", "hcaptchaToken": "..." }
//
// Example success response (proxied verbatim from inner route):
//   { "ok": true, "claimed": true, ... }
//
// Example error shape (standardized by this proxy if inner route fails):
//   { "ok": false, "code": "unsupported_chain", "message": "Selected chain is not yet supported." }
//
// Chains covered:
//   EVM: ETH, ARB, AVAX, OP, POL, BSC
//   Non-EVM (format passthrough): BTC, LTC, DOGE, XRP, XLM, SOL, TRX, DOT, ATOM

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ---------- Chain helpers ----------

type ChainSlug =
  | "eth" | "arb" | "avax" | "op" | "pol" | "bsc"
  | "btc" | "ltc" | "doge" | "xrp" | "xlm" | "sol" | "trx" | "dot" | "atom";

const CANON_MAP: Record<string, ChainSlug> = {
  // EVM
  eth: "eth",
  ethereum: "eth",
  arb: "arb",
  arbitrum: "arb",
  avax: "avax",
  avalanche: "avax",
  op: "op",
  optimism: "op",
  pol: "pol",
  polygon: "pol",
  matic: "pol",
  bsc: "bsc",
  bnb: "bsc",
  // Non-EVM
  btc: "btc",
  bitcoin: "btc",
  ltc: "ltc",
  litecoin: "ltc",
  doge: "doge",
  dogecoin: "doge",
  xrp: "xrp",
  ripple: "xrp",
  xlm: "xlm",
  stellar: "xlm",
  sol: "sol",
  solana: "sol",
  trx: "trx",
  tron: "trx",
  dot: "dot",
  polkadot: "dot",
  atom: "atom",
  cosmos: "atom",
};

const EVM_CHAINS: Set<ChainSlug> = new Set(["eth", "arb", "avax", "op", "pol", "bsc"]);

function canonChain(input: string | null | undefined): ChainSlug | null {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  return CANON_MAP[key] ?? null;
}

function isValidEvmTxHash(tx: unknown): boolean {
  if (typeof tx !== "string") return false;
  // 0x + 64 hex chars
  return /^0x[0-9a-fA-F]{64}$/.test(tx);
}

// ---------- Request handler ----------

export async function POST(req: NextRequest) {
  try {
    const json = await req.json().catch(() => null);
    if (!json || typeof json !== "object") {
      return jsonResp({ ok: false, code: "invalid_payload", message: "Invalid JSON body." });
    }

    const { chain, tx, message, hcaptchaToken } = json as {
      chain?: string;
      tx?: string;
      message?: string;
      hcaptchaToken?: string;
    };

    const c = canonChain(chain ?? "");
    if (!c) {
      return jsonResp({ ok: false, code: "unsupported_chain", message: "Selected chain is not yet supported." });
    }

    // EVM tx hash strict validation; non-EVM passthrough
    if (EVM_CHAINS.has(c) && !isValidEvmTxHash(tx)) {
      return jsonResp({ ok: false, code: "bad_tx_format", message: "Transaction hash format is invalid for this chain." });
    }

    // Build downstream request
    const secret = process.env.CRON_SECRET ?? "";
    if (!secret) {
      // Misconfiguration; do not leak internal details
      return jsonResp({ ok: false, code: "server_misconfig", message: "Service is temporarily unavailable." });
    }

    // Map message->note but keep backward compatibility if inner route still expects 'message'
    const body = {
      chain: c,
      tx,
      note: message ?? null,
      message: message ?? null,
      hcaptchaToken: hcaptchaToken ?? null,
    };

    const origin = process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL || "";
    // Use relative path to avoid origin mismatches in serverless envs
    const url = new URL(`/api/claim-ingest/${c}`, origin.startsWith("http") ? origin : "http://internal");

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": secret,
      },
      cache: "no-store",
      body: JSON.stringify(body),
    }).catch((_) => null);

    if (!resp) {
      return jsonResp({ ok: false, code: "rpc_error", message: "Upstream request failed." });
    }

    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      // Upstream not JSON (404 or other) -> standard unsupported
      if (resp.status === 404) {
        return jsonResp({ ok: false, code: "unsupported_chain", message: "Selected chain is not yet supported." });
      }
      return jsonResp({ ok: false, code: "upstream_non_json", message: "Unexpected upstream response." });
    }

    const payload = await resp.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return jsonResp({ ok: false, code: "upstream_non_json", message: "Unexpected upstream response." });
    }

    // Pass-through JSON (success or error) to the UI, stable 200 + no-store
    return NextResponse.json(payload, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonResp({ ok: false, code: "rpc_error", message: "Request failed." });
  }
}

// ---------- helpers ----------

function jsonResp(obj: any) {
  return NextResponse.json(obj, { status: 200, headers: { "cache-control": "no-store" } });
}

