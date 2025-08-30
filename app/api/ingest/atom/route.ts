// app/api/ingest/atom/route.ts
import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** ---------- Types ---------- */
type Wallet = {
  id: string;
  currency_id: string | null;
  address: string;
  chain: string | null;
  is_active: boolean | null;
};

type Currency = {
  id: string;
  symbol: string;
};

type AttemptLog = {
  url: string;
  headers: Record<string, string>;
  ok: boolean;
  status: number;
  detail?: string;
};

type PerWalletResultBase = {
  wallet: string;
  restBaseUsed: string;
  hasApiKey: boolean;
  attempts: AttemptLog[];
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
  attempts = 2,
  baseDelayMs = 250
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
 * Build multiple candidate URLs for GET /cosmos/tx/v1beta1/txs with repeated `events`.
 * Some gateways are picky about quotes (single vs double) and pagination key (limit vs pagination.limit).
 */
function buildCandidateUrls(base: string, address: string, limit: number): string[] {
  const restBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const mk = (events: string[], opts: { usePaginationLimit?: boolean }) => {
    const u = new URL(`${restBase}/cosmos/tx/v1beta1/txs`);
    for (const ev of events) u.searchParams.append("events", ev);
    u.searchParams.set("order_by", "ORDER_BY_DESC");
    if (opts.usePaginationLimit) {
      u.searchParams.set("pagination.limit", String(limit));
    } else {
      u.searchParams.set("limit", String(limit));
    }
    return u.toString();
  };

  const single = `'${address}'`;
  const dbl = `"${address}"`;

  const eventsTripletSingle = [
    `message.module='bank'`,
    `message.action='send'`,
    `transfer.recipient=${single}`,
  ];
  const eventsTripletDouble = [
    `message.module="bank"`,
    `message.action="send"`,
    `transfer.recipient=${dbl}`,
  ];

  return [
    // full triplet, single quotes
    mk(eventsTripletSingle, { usePaginationLimit: false }),
    mk(eventsTripletSingle, { usePaginationLimit: true }),
    // full triplet, double quotes
    mk(eventsTripletDouble, { usePaginationLimit: false }),
    mk(eventsTripletDouble, { usePaginationLimit: true }),
    // recipient only, single quotes
    mk([`transfer.recipient=${single}`], { usePaginationLimit: false }),
    mk([`transfer.recipient=${single}`], { usePaginationLimit: true }),
    // recipient only, double quotes
    mk([`transfer.recipient=${dbl}`], { usePaginationLimit: false }),
    mk([`transfer.recipient=${dbl}`], { usePaginationLimit: true }),
  ];
}

/** ---------- Supabase ---------- */
function getSupabaseServerClient() {
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

async function loadAtomCurrencyIdFromSupabase(): Promise<string[] /* currency ids */> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase
    .from("currencies")
    .select("id, symbol");

  if (error) throw new Error(`Supabase currencies query failed: ${error.message}`);

  const rows = (data || []) as Currency[];
  const atom = rows.filter((c) => (c.symbol || "").toUpperCase() === "ATOM");
  return atom.map((c) => c.id);
}

async function loadAtomWalletsFromSupabase(): Promise<Wallet[]> {
  const supabase = getSupabaseServerClient();

  // 1) Try by currency_id (preferred)
  const currencyIds = await loadAtomCurrencyIdFromSupabase();

  if (currencyIds.length > 0) {
    const { data, error } = await supabase
      .from("wallets")
      .select("id, currency_id, address, chain, is_active")
      .in("currency_id", currencyIds)
      .is("is_active", true); // only active

    if (error) throw new Error(`Supabase wallets query failed: ${error.message}`);
    const rows = (data || []) as Wallet[];
    // If no active rows, fall through to chain-based fallback
    if (rows.length > 0) {
      return rows.filter((w) => Boolean(w.address));
    }
  }

  // 2) Fallback by chain
  const { data: data2, error: error2 } = await supabase
    .from("wallets")
    .select("id, currency_id, address, chain, is_active")
    .ilike("chain", "cosmos%")
    .is("is_active", true); // only active

  if (error2) throw new Error(`Supabase wallets query failed: ${error2.message}`);

  const rows2 = (data2 || []) as Wallet[];
  return rows2.filter((w) => Boolean(w.address));
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
              "Supabase query returned no active ATOM/cosmos wallets. Ensure `currencies.symbol = 'ATOM'` mapped to wallets.currency_id or set wallets.chain ~ 'cosmos%' with is_active=true.",
            durationMs: Date.now() - startedAt,
          },
          200
        );
      }
    }

    // Query LCD per wallet trying multiple candidate encodings
    const results: PerWalletResult[] = [];
    for (const address of wallets) {
      const t0 = Date.now();
      const candidates = buildCandidateUrls(restBase, address, limit);

      const attempts: AttemptLog[] = [];
      let finalOk = false;
      let finalTxs: any[] = [];
      let finalStatus = 0;
      let finalDetail = "";

      for (const queryUrl of candidates) {
        try {
          const headers: Record<string, string> = {
            accept: "application/json",
            "cache-control": "no-store",
            ...(hasApiKey ? { "api-key": apiKeyHeader } : {}),
          };

          const res = await fetchWithRetry(
            queryUrl,
            { method: "GET", headers },
            2,
            250
          );

          const ct = res.headers.get("content-type") || "";
          const ok = res.ok;

          if (!ok) {
            const raw = ct.includes("application/json")
              ? await res.json().catch(async () => ({ raw: await res.text() }))
              : { raw: await res.text() };

            const detail =
              (raw && typeof raw === "object" && "message" in raw && (raw as any).message) ||
              (raw && typeof raw === "object" && "error" in raw && (raw as any).error) ||
              (raw && typeof raw === "object" && "raw" in raw && (raw as any).raw) ||
              JSON.stringify(raw);

            attempts.push({ url: queryUrl, headers, ok, status: res.status, detail: String(detail) });
            finalStatus = res.status;
            finalDetail = String(detail);
            continue; // try next candidate
          }

          // Success path
          const data = ct.includes("application/json")
            ? await res.json()
            : await res.text();

          const txs =
            (data && typeof data === "object" && (data as any).txs) ||
            (data && typeof data === "object" && (data as any).tx_responses) ||
            [];

          attempts.push({ url: queryUrl, headers, ok: true, status: res.status });
          finalOk = true;
          finalTxs = Array.isArray(txs) ? txs : [];
          finalStatus = res.status;
          break; // stop on first success
        } catch (err: any) {
          attempts.push({
            url: queryUrl,
            headers: {
              accept: "application/json",
              ...(hasApiKey ? { "api-key": apiKeyHeader } : {}),
            },
            ok: false,
            status: 0,
            detail: err?.message ?? String(err),
          });
          finalDetail = err?.message ?? String(err);
        }
      }

      const ms = Date.now() - t0;

      if (finalOk) {
        results.push({
          wallet: address,
          ok: true,
          txCount: finalTxs.length,
          txs: finalTxs,
          status: finalStatus,
          restBaseUsed: restBase,
          hasApiKey,
          attempts,
          ms,
        });
      } else {
        results.push({
          wallet: address,
          ok: false,
          error: "LCD query failed",
          detail: finalDetail || "All candidate query encodings failed",
          status: finalStatus || undefined,
          restBaseUsed: restBase,
          hasApiKey,
          attempts,
          ms,
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

