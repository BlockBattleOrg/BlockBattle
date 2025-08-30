// app/api/ingest/atom/route.ts
import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ---------- Types ---------- */
type Wallet = {
  address: string;
  chain?: string | null;
  symbol?: string | null;
  enabled?: boolean | null;
};

type PerWalletResult =
  | {
      wallet: string;
      ok: true;
      queryUrl: string;
      txCount: number;
      txs: unknown[];
      status: number;
      ms: number;
    }
  | {
      wallet: string;
      ok: false;
      error: string;
      detail?: string;
      status?: number;
      ms: number;
    };

type IngestOk = {
  ok: true;
  chain: "cosmos";
  symbol: "ATOM";
  mode: "bulk-from-supabase" | "single-address";
  totalWallets: number;
  results: PerWalletResult[];
  durationMs: number;
};

type IngestErr = {
  ok: false;
  error: string;
  detail?: string;
  status?: number;
  durationMs: number;
};

/** ---------- Helpers ---------- */
function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readJsonBody(req: NextRequest): Promise<any | null> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  try {
    const obj = await req.json();
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit,
  attempts = 3,
  baseDelayMs = 300
): Promise<Response> {
  let lastErr: any = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(input, init);
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr ?? new Error("Fetch failed");
}

/**
 * Build Cosmos LCD tx search URL for "transfer.recipient = '<address>'".
 * We must URL-encode the single quotes around the address.
 */
function buildTxSearchUrl(base: string, address: string, limit: number): string {
  const encodedAddress = encodeURIComponent(`'${address}'`); // %27<ADDR>%27
  const params = new URLSearchParams({
    events: `transfer.recipient%3D${encodedAddress}`, // keep `%3D` for '=' to avoid double encoding issues on some LCDs
    order_by: "ORDER_BY_DESC",
    limit: String(limit),
  });
  const sep = base.endsWith("/") ? "" : "/";
  return `${base}${sep}cosmos/tx/v1beta1/txs?${params.toString()}`;
}

/** ---------- Supabase ---------- */
function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = process.env.SUPABASE_ANON_KEY;
  if (!url) throw new Error("SUPABASE_URL is not set");

  // Prefer service role (server-only) for backend cron jobs; fallback to anon if needed.
  const key = serviceRole || anon;
  if (!key) throw new Error("Neither SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_ANON_KEY is set");

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}

async function loadAtomWalletsFromSupabase(): Promise<Wallet[]> {
  const supabase = getSupabaseServerClient();

  // Adjust the query to match your schema:
  // - table: wallets
  // - columns: address (text), chain (text), symbol (text), enabled (bool)
  // - filter: chain = 'cosmos' AND symbol = 'ATOM' AND (enabled IS TRUE OR enabled IS NULL)
  const { data, error } = await supabase
    .from("wallets")
    .select("address, chain, symbol, enabled")
    .ilike("chain", "cosmos")
    .ilike("symbol", "atom");

  if (error) {
    throw new Error(`Supabase wallets query failed: ${error.message}`);
  }

  const rows = (data || []) as Wallet[];
  // Optional filter for enabled=true if you have it
  const filtered = rows.filter(
    (w) =>
      w.address &&
      (w.enabled === null || w.enabled === undefined || w.enabled === true)
  );

  return filtered;
}

/** ---------- Handler ---------- */
export async function POST(req: NextRequest): Promise<Response> {
  const startedAt = Date.now();

  try {
    // Secret gate (protects both LCD quotas and optional service role usage)
    const providedSecret = req.headers.get("x-cron-secret") || "";
    const expectedSecret = process.env.CRON_SECRET || "";
    if (!expectedSecret) {
      return json(
        <IngestErr>{
          ok: false,
          error: "Missing CRON_SECRET",
          detail: "Environment variable CRON_SECRET is not set on the server.",
          durationMs: Date.now() - startedAt,
        },
        500
      );
    }
    if (providedSecret !== expectedSecret) {
      return json(
        <IngestErr>{
          ok: false,
          error: "Unauthorized",
          detail: "Invalid or missing x-cron-secret.",
          durationMs: Date.now() - startedAt,
        },
        401
      );
    }

    // Resolve LCD config
    const lcdBase = (process.env.ATOM_LCD_URL || "").trim(); // e.g. https://atom.nownodes.io
    if (!lcdBase) {
      return json(
        <IngestErr>{
          ok: false,
          error: "Missing ATOM_LCD_URL",
          detail: "Set ATOM_LCD_URL (e.g., https://atom.nownodes.io) in environment.",
          durationMs: Date.now() - startedAt,
        },
        500
      );
    }
    const apiKeyHeader = (process.env.NOWNODES_API_KEY || "").trim();

    // Limit per wallet
    const limitEnv = Number(process.env.ATOM_TX_LIMIT || "10");
    const limit = Number.isFinite(limitEnv) && limitEnv > 0 ? limitEnv : 10;

    // Address override (single-address mode)
    const url = new URL(req.url);
    const qsAddress = url.searchParams.get("address") || "";
    const body = await readJsonBody(req);
    const bodyAddress = body?.address || "";
    const addressOverride = (qsAddress || bodyAddress).trim();

    // Compute wallets
    let wallets: string[] = [];
    let mode: IngestOk["mode"] = "bulk-from-supabase";

    if (addressOverride) {
      mode = "single-address";
      wallets = [addressOverride];
    } else {
      const rows = await loadAtomWalletsFromSupabase();
      wallets = rows.map((w) => (w.address || "").trim()).filter(Boolean);
      if (wallets.length === 0) {
        return json(
          <IngestErr>{
            ok: false,
            error: "No wallets found",
            detail:
              "Supabase table `wallets` returned no ATOM/cosmos addresses. Ensure rows exist and match filters.",
            durationMs: Date.now() - startedAt,
          },
          200
        );
      }
    }

    // For each wallet, query LCD
    const results: PerWalletResult[] = [];
    for (const address of wallets) {
      const t0 = Date.now();
      try {
        const queryUrl = buildTxSearchUrl(lcdBase, address, limit);
        const res = await fetchWithRetry(
          queryUrl,
          {
            method: "GET",
            headers: {
              ...(apiKeyHeader ? { "api-key": apiKeyHeader } : {}),
              "cache-control": "no-store",
            },
          },
          3,
          400
        );

        const ct = res.headers.get("content-type") || "";
        if (!res.ok) {
          const raw = ct.includes("application/json")
            ? await res.json().catch(async () => ({ raw: await res.text() }))
            : { raw: await res.text() };

          const detail =
            (raw && typeof raw === "object" && "message" in raw && (raw as any).message) ||
            (raw && typeof raw === "object" && "error" in raw && (raw as any).error) ||
            (raw && typeof raw === "object" && "raw" in raw && (raw as any).raw) ||
            JSON.stringify(raw);

          results.push({
            wallet: address,
            ok: false,
            error: "LCD query failed",
            detail: `LCD ${res.status}: ${detail}`,
            status: res.status,
            ms: Date.now() - t0,
          });
          continue;
        }

        const data = ct.includes("application/json")
          ? await res.json()
          : await res.text();

        const txs =
          (data && typeof data === "object" && (data as any).txs) ||
          (data && typeof data === "object" && (data as any).tx_responses) ||
          [];

        results.push({
          wallet: address,
          ok: true,
          queryUrl,
          txCount: Array.isArray(txs) ? txs.length : 0,
          txs: Array.isArray(txs) ? txs : [],
          status: res.status,
          ms: Date.now() - t0,
        });
      } catch (err: any) {
        results.push({
          wallet: address,
          ok: false,
          error: "Unhandled exception during LCD query",
          detail: err?.message ?? String(err),
          ms: Date.now() - t0,
        });
      }
    }

    return json(
      <IngestOk>{
        ok: true,
        chain: "cosmos",
        symbol: "ATOM",
        mode,
        totalWallets: wallets.length,
        results,
        durationMs: Date.now() - startedAt,
      },
      200
    );
  } catch (err: any) {
    return json(
      <IngestErr>{
        ok: false,
        error: "Unhandled exception in /api/ingest/atom",
        detail: err?.message ?? String(err),
        durationMs: Date.now() - startedAt,
      },
      500
    );
  }
}

export async function GET() {
  return json(
    {
      ok: false,
      error: "Method Not Allowed",
      detail: "Use POST for /api/ingest/atom",
    },
    405
  );
}

