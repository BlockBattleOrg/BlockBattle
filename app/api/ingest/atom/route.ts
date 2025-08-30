// app/api/ingest/atom/route.ts
import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ---------- Types ---------- */
type Wallet = {
  address: string;
  chain?: string | null;
  enabled?: boolean | null;
};

type PerWalletResultBase = {
  wallet: string;
  restBaseUsed: string;
  hasApiKey: boolean;
  queryUrl: string;
  eventsRaw: string[];
  status?: number;
  ms: number;
};

type PerWalletResultSuccess = PerWalletResultBase & {
  ok: true;
  txCount: number;
  txs: unknown[];
};

type PerWalletResultError = PerWalletResultBase & {
  ok: false;
  error: string;
  detail?: string;
};

type PerWalletResult = PerWalletResultSuccess | PerWalletResultError;

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
  debug?: Record<string, unknown>;
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
 * Build a GET /cosmos/tx/v1beta1/txs URL using repeated `events` params.
 * Many gateways behave best when you include module/action along with recipient.
 */
function buildTxSearchUrl(
  base: string,
  address: string,
  limit: number
): { url: string; eventsRaw: string[] } {
  const restBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const u = new URL(`${restBase}/cosmos/tx/v1beta1/txs`);

  // Use multiple event filters (common for bank send txs)
  const events = [
    `message.module='bank'`,
    `message.action='send'`,
    `transfer.recipient='${address}'`,
  ];

  // Add each event as a separate query param `events=...`
  for (const ev of events) {
    u.searchParams.append("events", ev);
  }
  // Sorting and pagination (some LCDs accept limit or pagination.limit; NowNodes supports limit)
  u.searchParams.set("order_by", "ORDER_BY_DESC");
  u.searchParams.set("limit", String(limit));

  return { url: u.toString(), eventsRaw: events };
}

/** ---------- Supabase ---------- */
function getSupabaseServerClient() {
  // Accept both server and NEXT_PUBLIC fallbacks
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "";

  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) throw new Error("SUPABASE_URL is not set");

  const key = serviceRole || anon;
  if (!key) throw new Error("Neither SUPABASE_SERVICE_ROLE_KEY nor SUPABASE_ANON_KEY is set");

  return createClient(url, key, { auth: { persistSession: false } });
}

async function loadAtomWalletsFromSupabase(): Promise<Wallet[]> {
  const supabase = getSupabaseServerClient();

  // Query only columns that exist. Filter by chain ~ 'cosmos'.
  const { data, error } = await supabase
    .from("wallets")
    .select("address, chain, enabled")
    .ilike("chain", "cosmos%");

  if (error) throw new Error(`Supabase wallets query failed: ${error.message}`);

  const rows = (data || []) as Wallet[];
  return rows.filter(
    (w) =>
      w.address &&
      (w.enabled === null || w.enabled === undefined || w.enabled === true)
  );
}

/** ---------- Handler ---------- */
export async function POST(req: NextRequest): Promise<Response> {
  const startedAt = Date.now();

  try {
    // Secret gate
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

    // REST (LCD) base URL
    const restBase =
      (process.env.ATOM_REST_URL || "").trim() ||
      (process.env.ATOM_LCD_URL || "").trim();
    if (!restBase) {
      return json(
        <IngestErr>{
          ok: false,
          error: "Missing ATOM_REST_URL",
          detail:
            "Set ATOM_REST_URL (e.g., https://atom.nownodes.io) in environment. Fallback ATOM_LCD_URL is also supported.",
          debug: {
            ATOM_REST_URL: process.env.ATOM_REST_URL ?? null,
            ATOM_LCD_URL: process.env.ATOM_LCD_URL ?? null,
          },
          durationMs: Date.now() - startedAt,
        },
        500
      );
    }

    // NowNodes api-key header
    const hasApiKey = Boolean((process.env.NOWNODES_API_KEY || "").trim());
    const apiKeyHeader = (process.env.NOWNODES_API_KEY || "").trim();

    // Limit per wallet
    const limitEnv = Number(process.env.ATOM_TX_LIMIT || "10");
    const limit = Number.isFinite(limitEnv) && limitEnv > 0 ? limitEnv : 10;

    // Single-address override (query/body)
    const url = new URL(req.url);
    const qsAddress = url.searchParams.get("address") || "";
    const bodyIn = await readJsonBody(req);
    const bodyAddress = bodyIn?.address || "";
    const addressOverride = (qsAddress || bodyAddress).trim();

    // Wallet set
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
              "Supabase table `wallets` returned no cosmos addresses. Ensure rows exist and match filters.",
            durationMs: Date.now() - startedAt,
          },
          200
        );
      }
    }

    // Query LCD per wallet using GET with repeated `events`
    const results: PerWalletResult[] = [];
    for (const address of wallets) {
      const t0 = Date.now();
      const built = buildTxSearchUrl(restBase, address, limit);
      const queryUrl = built.url;
      const eventsRaw = built.eventsRaw;

      try {
        const res = await fetchWithRetry(
          queryUrl,
          {
            method: "GET",
            headers: {
              ...(hasApiKey ? { "api-key": apiKeyHeader } : {}),
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
            detail: String(detail),
            status: res.status,
            restBaseUsed: restBase,
            hasApiKey,
            queryUrl,
            eventsRaw,
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
          status: res.status,
          restBaseUsed: restBase,
          hasApiKey,
          queryUrl,
          eventsRaw,
          txCount: Array.isArray(txs) ? txs.length : 0,
          txs: Array.isArray(txs) ? txs : [],
          ms: Date.now() - t0,
        });
      } catch (err: any) {
        results.push({
          wallet: address,
          ok: false,
          error: "Unhandled exception during LCD query",
          detail: err?.message ?? String(err),
          status: undefined,
          restBaseUsed: restBase,
          hasApiKey,
          queryUrl,
          eventsRaw,
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

