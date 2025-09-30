// app/api/claim/route.ts
// Public claim proxy (single entrypoint used by /claim UI).
// Accepts { chain, tx, message, hcaptchaToken? } and forwards to
// /api/claim-ingest/:chain while preserving body (message -> note).

import { NextRequest, NextResponse } from "next/server";
import { canonChain, isEvmChain, isValidEvmTxHash, ChainSlug } from "@/lib/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

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

    const c: ChainSlug | null = canonChain(chain ?? "");
    if (!c) {
      return jsonResp({ ok: false, code: "unsupported_chain", message: "Selected chain is not yet supported." });
    }

    // EVM tx hash strict validation; non-EVM passthrough
    if (isEvmChain(c) && !isValidEvmTxHash(tx)) {
      return jsonResp({ ok: false, code: "bad_tx_format", message: "Transaction hash format is invalid for this chain." });
    }

    // Build downstream request
    const secret = process.env.CRON_SECRET ?? "";
    if (!secret) {
      return jsonResp({ ok: false, code: "server_misconfig", message: "Service is temporarily unavailable." });
    }

    const body = {
      chain: c,
      tx,
      note: message ?? null,
      message: message ?? null,
      hcaptchaToken: hcaptchaToken ?? null,
    };

    const origin = process.env.NEXT_PUBLIC_BASE_URL || process.env.VERCEL_URL || "";
    const url = new URL(`/api/claim-ingest/${c}`, origin.startsWith("http") ? origin : "http://internal");

    const resp = await fetch(url.toString(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cron-secret": secret,
      },
      cache: "no-store",
      body: JSON.stringify(body),
    }).catch(() => null);

    if (!resp) {
      return jsonResp({ ok: false, code: "rpc_error", message: "Upstream request failed." });
    }

    const contentType = resp.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      if (resp.status === 404) {
        return jsonResp({ ok: false, code: "unsupported_chain", message: "Selected chain is not yet supported." });
      }
      return jsonResp({ ok: false, code: "upstream_non_json", message: "Unexpected upstream response." });
    }

    const payload = await resp.json().catch(() => null);
    if (!payload || typeof payload !== "object") {
      return jsonResp({ ok: false, code: "upstream_non_json", message: "Unexpected upstream response." });
    }

    return NextResponse.json(payload, { status: 200, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return jsonResp({ ok: false, code: "rpc_error", message: "Request failed." });
  }
}

function jsonResp(obj: any) {
  return NextResponse.json(obj, { status: 200, headers: { "cache-control": "no-store" } });
}

