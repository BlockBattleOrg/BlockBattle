// app/api/ingest/contrib/xlm/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const HORIZON = (process.env.XLM_HORIZON_URL || "").replace(/\/+$/, "");
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();
// If your Horizon provider requires an API key (e.g. a managed endpoint), we try NOWNODES_API_KEY header.
const OPTIONAL_API_KEY = (process.env.NOWNODES_API_KEY || "").trim();

const MAX_PAGES = Number(process.env.XLM_CONTRIB_MAX_PAGES || 5); // safety cap: pages per wallet
const PAGE_LIMIT = 200; // Horizon usually allows up to 200

type Json = any;

function isXLM(symbol?: string | null, chain?: string | null) {
  const s = String(symbol || "").trim().toUpperCase();
  const c = String(chain || "").trim().toUpperCase().replace(/\s+/g, "");
  return s === "XLM" || c === "XLM" || c === "STELLAR";
}
function relFirst<T = any>(maybe: any): T | undefined {
  if (!maybe) return undefined;
  return Array.isArray(maybe) ? maybe[0] : maybe;
}

/**
 * GET helper for Horizon with tolerant 404:
 * If the account doesn't exist (unfunded) Horizon returns 404.
 * We convert that into an empty records page to avoid failing the whole run.
 */
async function hget(path: string, params: Record<string, string | number | undefined>) {
  if (!HORIZON) throw new Error("Missing XLM_HORIZON_URL");
  const url = new URL(HORIZON + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (OPTIONAL_API_KEY) headers["api-key"] = OPTIONAL_API_KEY;

  const res = await fetch(url.toString(), { headers });

  // Tolerate unfunded accounts (404 "Resource Missing") → treat as no payments yet
  if (res.status === 404) {
    return { _embedded: { records: [] } };
  }

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`XLM Horizon HTTP ${res.status} ${res.statusText}${txt ? `: ${txt}` : ""}`);
  }
  return res.json() as Promise<any>;
}

export async function POST(req: Request) {
  try {
    // Auth
    if (!CRON_SECRET || (req.headers.get("x-cron-secret") || "") !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
    }
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Load active XLM wallets
    const { data: walletsAll, error: wErr } = await sb
      .from("wallets")
      .select(`
        id, address, chain, is_active, currency_id,
        currencies:currency_id ( symbol )
      `)
      .eq("is_active", true);
    if (wErr) throw wErr;

    const wallets = (walletsAll || []).filter(
      (w: any) => w?.address && isXLM(relFirst(w?.currencies)?.symbol, w?.chain)
    );
    if (wallets.length === 0) {
      return NextResponse.json({ ok: true, info: "No XLM wallets active; nothing to ingest.", inserted: 0 });
    }

    // 2) Per-wallet scan via /accounts/{account}/payments
    //    We keep per-wallet Horizon cursor in settings:
    //    key = xlm_contrib_cursor_<wallet_id>  value = { cursor: "<paging_token>" }
    const agg = new Map<string, { wallet_id: string; tx_hash: string; amount: number; block_time: string }>();
    let scannedOps = 0;

    for (const w of wallets) {
      const walletId = String((w as any).id);
      const account = String((w as any).address).trim();
      if (!account) continue;

      const cursorKey = `xlm_contrib_cursor_${walletId}`;
      const { data: sRow } = await sb.from("settings").select("value").eq("key", cursorKey).maybeSingle();
      let cursor: string | undefined = (sRow as any)?.value?.cursor;

      let pages = 0;
      let lastPagingToken: string | null = null;

      while (pages < MAX_PAGES) {
        const out = await hget(`/accounts/${account}/payments`, {
          order: "asc",
          limit: PAGE_LIMIT,
          cursor,
        });

        const recs: any[] = out?._embedded?.records || [];
        if (recs.length === 0) break;

        for (const r of recs) {
          // Only incoming native payments
          if (r?.type !== "payment") continue;
          if (String(r?.to || "") !== account) continue;
          if (r?.asset_type !== "native") continue;

          const amt = Number(r?.amount);
          if (!Number.isFinite(amt) || amt <= 0) continue;

          const txHash = String(r?.transaction_hash || "");
          if (!txHash) continue;

          const createdAt = String(r?.created_at || new Date().toISOString());

          const key = `${txHash}:${walletId}`;
          const prev = agg.get(key);
          if (prev) prev.amount += amt;
          else agg.set(key, { wallet_id: walletId, tx_hash: txHash, amount: amt, block_time: createdAt });

          lastPagingToken = String(r?.paging_token || "") || lastPagingToken;
          scannedOps++;
        }

        pages++;
        if (recs.length < PAGE_LIMIT) break;
        cursor = String(recs[recs.length - 1]?.paging_token || "") || cursor;
        if (!cursor) break;
      }

      if (lastPagingToken) {
        await sb.from("settings").upsert(
          { key: cursorKey, value: { cursor: lastPagingToken } },
          { onConflict: "key" }
        );
      }
    }

    const candidates = Array.from(agg.values());

    // 3) De-dup by (tx_hash, wallet_id)
    let existing = new Set<string>();
    if (candidates.length) {
      const uniq = Array.from(new Set(candidates.map((r) => r.tx_hash)));
      const { data: ex } = await sb.from("contributions").select("tx_hash, wallet_id").in("tx_hash", uniq);
      existing = new Set((ex || []).map((e: any) => `${e.tx_hash}:${e.wallet_id}`));
    }
    const rows = candidates.filter((r) => !existing.has(`${r.tx_hash}:${r.wallet_id}`));

    if (rows.length) {
      const { error: insErr } = await sb.from("contributions").insert(rows);
      if (insErr) throw insErr;
    }

    return NextResponse.json({
      ok: true,
      chain: "XLM",
      wallets: wallets.length,
      scanned_ops: scannedOps,
      candidates: candidates.length,
      inserted: rows.length,
      pages_per_wallet_cap: MAX_PAGES,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "XLM contrib ingest failed" }, { status: 500 });
  }
}

