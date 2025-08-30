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
  phase: "lcd-events" | "lcd-query" | "rpc";
};

type PerWalletResultBase = {
  wallet: string;
  restBaseUsed: string;
  rpcBaseUsed?: string | null;
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

/** ---------- LCD (REST) candidates ---------- */
function buildLcdEventsCandidates(base: string, address: string, limit: number): string[] {
  const restBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const mk = (events: string[], opts: { usePaginationLimit?: boolean }) => {
    const u = new URL(`${restBase}/cosmos/tx/v1beta1/txs`);
    for (const ev of events) u.searchParams.append("events", ev);
    u.searchParams.set("order_by", "ORDER_BY_DESC");
    if (opts.usePaginationLimit) u.searchParams.set("pagination.limit", String(limit));
    else u.searchParams.set("limit", String(limit));
    return u.toString();
  };

  const single = `'${address}'`;
  const dbl = `"${address}"`;

  const tripletSingle = [`message.module='bank'`, `message.action='send'`, `transfer.recipient=${single}`];
  const tripletDouble = [`message.module="bank"`, `message.action="send"`, `transfer.recipient=${dbl}`];

  return [
    mk(tripletSingle, { usePaginationLimit: false }),
    mk(tripletSingle, { usePaginationLimit: true }),
    mk(tripletDouble, { usePaginationLimit: false }),
    mk(tripletDouble, { usePaginationLimit: true }),
    mk([`transfer.recipient=${single}`], { usePaginationLimit: false }),
    mk([`transfer.recipient=${single}`], { usePaginationLimit: true }),
    mk([`transfer.recipient=${dbl}`], { usePaginationLimit: false }),
    mk([`transfer.recipient=${dbl}`], { usePaginationLimit: true }),
    // also try sender (for outgoing)
    mk([`message.sender=${single}`], { usePaginationLimit: false }),
    mk([`message.sender=${dbl}`], { usePaginationLimit: false }),
  ];
}

/** Some LCDs use `query=` (tendermint style) instead of `events=` */
function buildLcdQueryCandidates(base: string, address: string, limit: number): string[] {
  const restBase = base.endsWith("/") ? base.slice(0, -1) : base;
  const mk = (q: string, usePaginationLimit = false) => {
    const u = new URL(`${restBase}/cosmos/tx/v1beta1/txs`);
    u.searchParams.set("query", q);
    u.searchParams.set("order_by", "ORDER_BY_DESC");
    if (usePaginationLimit) u.searchParams.set("pagination.limit", String(limit));
    else u.searchParams.set("limit", String(limit));
    return u.toString();
  };

  const q1 = `"transfer.recipient='${address}'"`;
  const q2 = `"message.module='bank' AND message.action='send' AND transfer.recipient='${address}'"`;
  const q3 = `"message.sender='${address}'"`; // outgoing

  return [
    mk(q1, false),
    mk(q1, true),
    mk(q2, false),
    mk(q2, true),
    mk(q3, false),
    mk(q3, true),
  ];
}

/** ---------- RPC (Tendermint) candidates ---------- */
function buildRpcCandidates(rpcBase: string, address: string, perPage: number): string[] {
  const base = rpcBase.endsWith("/") ? rpcBase.slice(0, -1) : rpcBase;
  const mk = (q: string) => {
    const u = new URL(`${base}/tx_search`);
    u.searchParams.set("query", q);
    u.searchParams.set("per_page", String(perPage));
    u.searchParams.set("order_by", "desc");
    return u.toString();
  };

  const q1 = `"transfer.recipient='${address}'"`;
  const q2 = `"tm.event='Tx' AND transfer.recipient='${address}'"`;
  const q3 = `"message.sender='${address}'"`;
  const q4 = `"tm.event='Tx' AND message.sender='${address}'"`;

  return [mk(q1), mk(q2), mk(q3), mk(q4)];
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

async function loadAtomCurrencyIds(): Promise<string[]> {
  const supabase = getSupabaseServerClient();
  const { data, error } = await supabase.from("currencies").select("id,symbol");
  if (error) throw new Error(`Supabase currencies query failed: ${error.message}`);
  return (data || [])
    .filter((c: any) => String(c.symbol || "").toUpperCase() === "ATOM")
    .map((c: any) => c.id);
}

async function loadAtomWalletsFromSupabase(): Promise<Wallet[]> {
  const supabase = getSupabaseServerClient();
  const currencyIds = await loadAtomCurrencyIds();

  if (currencyIds.length > 0) {
    const { data, error } = await supabase
      .from("wallets")
      .select("id,currency_id,address,chain,is_active")
      .in("currency_id", currencyIds)
      .is("is_active", true);

    if (error) throw new Error(`Supabase wallets query failed: ${error.message}`);
    const rows = (data || []) as Wallet[];
    if (rows.length > 0) return rows.filter((w) => Boolean(w.address));
  }

  // Fallback by chain
  const { data: data2, error: error2 } = await supabase
    .from("wallets")
    .select("id,currency_id,address,chain,is_active")
    .ilike("chain", "cosmos%")
    .is("is_active", true);

  if (error2) throw new Error(`Supabase wallets query failed: ${error2.message}`);
  return (data2 || []).filter((w: any) => Boolean(w.address));
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

    // RPC (Tendermint) base URL (optional fallback)
    const rpcBase = (process.env.ATOM_RPC_URL || "").trim() || null;

    // NowNodes api-key header
    const rawKey = (process.env.NOWNODES_API_KEY || "").trim();
    const hasApiKey = Boolean(rawKey);
    const apiKeyHeader = rawKey;

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
              "Supabase returned no active ATOM/cosmos wallets. Ensure currencies.symbol='ATOM' is linked via wallets.currency_id or set wallets.chain ~ 'cosmos%' with is_active=true.",
            durationMs: Date.now() - startedAt,
          },
          200
        );
      }
    }

    // Query per wallet with phased fallbacks
    const results: PerWalletResult[] = [];
    for (const address of wallets) {
      const t0 = Date.now();
      const attempts: AttemptLog[] = [];
      let finalOk = false;
      let finalTxs: any[] = [];
      let finalStatus = 0;
      let finalDetail = "";
      let usedRpcBase: string | null = null;

      // Phase 1: LCD events=
      for (const queryUrl of buildLcdEventsCandidates(restBase, address, limit)) {
        const maskedKey = hasApiKey ? apiKeyHeader.replace(/.(?=.{4})/g, "*") : "";
        const headers: Record<string, string> = {
          accept: "application/json",
          "cache-control": "no-store",
          ...(hasApiKey ? { "api-key": apiKeyHeader } : {}),
        };

        const res = await fetchWithRetry(queryUrl, { method: "GET", headers }, 2, 250);
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

          attempts.push({
            url: queryUrl,
            headers: { ...headers, ...(hasApiKey ? { "api-key": maskedKey } : {}) },
            ok: false,
            status: res.status,
            detail: String(detail),
            phase: "lcd-events",
          });

          // if NowNodes keeps saying "query cannot be empty", we'll fall back later
          finalStatus = res.status;
          finalDetail = String(detail);
          continue;
        }

        const data = ct.includes("application/json") ? await res.json() : await res.text();
        const txs =
          (data && typeof data === "object" && (data as any).txs) ||
          (data && typeof data === "object" && (data as any).tx_responses) ||
          [];

        attempts.push({
          url: queryUrl,
          headers: { ...headers, ...(hasApiKey ? { "api-key": maskedKey } : {}) },
          ok: true,
          status: res.status,
          phase: "lcd-events",
        });

        finalOk = true;
        finalTxs = Array.isArray(txs) ? txs : [];
        finalStatus = res.status;
        break;
      }

      // Phase 2: LCD query= fallback
      if (!finalOk) {
        for (const queryUrl of buildLcdQueryCandidates(restBase, address, limit)) {
          const maskedKey = hasApiKey ? apiKeyHeader.replace(/.(?=.{4})/g, "*") : "";
          const headers: Record<string, string> = {
            accept: "application/json",
            "cache-control": "no-store",
            ...(hasApiKey ? { "api-key": apiKeyHeader } : {}),
          };

          const res = await fetchWithRetry(queryUrl, { method: "GET", headers }, 2, 250);
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

            attempts.push({
              url: queryUrl,
              headers: { ...headers, ...(hasApiKey ? { "api-key": maskedKey } : {}) },
              ok: false,
              status: res.status,
              detail: String(detail),
              phase: "lcd-query",
            });

            finalStatus = res.status;
            finalDetail = String(detail);
            continue;
          }

          const data = ct.includes("application/json") ? await res.json() : await res.text();
          const txs =
            (data && typeof data === "object" && (data as any).txs) ||
            (data && typeof data === "object" && (data as any).tx_responses) ||
            [];

          attempts.push({
            url: queryUrl,
            headers: { ...headers, ...(hasApiKey ? { "api-key": maskedKey } : {}) },
            ok: true,
            status: res.status,
            phase: "lcd-query",
          });

          finalOk = true;
          finalTxs = Array.isArray(txs) ? txs : [];
          finalStatus = res.status;
          break;
        }
      }

      // Phase 3: RPC /tx_search fallback (if configured)
      if (!finalOk && rpcBase) {
        usedRpcBase = rpcBase;
        for (const queryUrl of buildRpcCandidates(rpcBase, address, limit)) {
          const headers: Record<string, string> = {
            accept: "application/json",
            "cache-control": "no-store",
            ...(hasApiKey ? { "api-key": apiKeyHeader } : {}),
          };

          const res = await fetchWithRetry(queryUrl, { method: "GET", headers }, 2, 250);
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

            attempts.push({
              url: queryUrl,
              headers,
              ok: false,
              status: res.status,
              detail: String(detail),
              phase: "rpc",
            });

            finalStatus = res.status;
            finalDetail = String(detail);
            continue;
          }

          const data = ct.includes("application/json") ? await res.json() : await res.text();
          // Tendermint tx_search returns { result: { txs: [...] } } or { txs: [...] } depending on proxy
          // Normalize to array
          const txs =
            (data && typeof data === "object" && (data as any).result && (data as any).result.txs) ||
            (data && typeof data === "object" && (data as any).txs) ||
            [];

          attempts.push({
            url: queryUrl,
            headers,
            ok: true,
            status: res.status,
            phase: "rpc",
          });

          finalOk = true;
          finalTxs = Array.isArray(txs) ? txs : [];
          finalStatus = res.status;
          break;
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
          rpcBaseUsed: usedRpcBase ?? null,
          hasApiKey,
          attempts,
          ms,
        });
      } else {
        results.push({
          wallet: address,
          ok: false,
          error: "LCD query failed",
          detail: finalDetail || "All candidate query encodings failed (events=, query=, and rpc tx_search).",
          status: finalStatus || undefined,
          restBaseUsed: restBase,
          rpcBaseUsed: usedRpcBase ?? null,
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

