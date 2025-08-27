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
// If you use a Horizon that requires API key (e.g. some providers), we try NOWNODES_API_KEY header.
const OPTIONAL_API_KEY = (process.env.NOWNODES_API_KEY || "").trim();

const MAX_PAGES = Number(process.env.XLM_CONTRIB_MAX_PAGES || 5); // safety cap per wallet (pages of 200)
const PAGE_LIMIT = 200; // Horizon max is typically 200

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

async function hget(path: string, params: Record<string, string | number | undefined>) {
  if (!HORIZON) throw new Error("Missing XLM_HORIZON_URL");
  const url = new URL(HORIZON + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (OPTIONAL_API_KEY) headers["api-key"] = OPTIONAL_API_KEY;
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`XLM Horizon HTTP ${res.status} ${res.statusText}${txt ? `: ${txt}` : ""}`);
  }
  return res.json() as Promise<any>;
}

export async function POST(req: Request) {
  try {
    // auth
    if (!CRON_SECRET || (req.headers.get("x-cron-secret") || "") !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
    }
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Active XLM wallets
    const { data: walletsAll, error: wErr } = await sb
      .from("wallets")
      .select(`
        id, address, chain, is_active, currency_id,
        currencies:currency_id ( symbol )
      `)
      .eq("is_active", true);
    if (wErr) throw wErr;

    const wallets = (walletsAll || []).filter((w: any) => w?.address && isXLM(relFirst(w?.currencies)?.symbol, w?.chain));
    if (wallets.length === 0) {
      return NextResponse.json({ ok: true, info: "No XLM wallets active; nothing to ingest.", inserted: 0 });
    }

    // 2) Scan per wallet using /accounts/{account}/payments (incoming, native)
    // We keep per-wallet cursor in settings: key = xlm_contrib_cursor_<wallet_id> { cursor: "<paging_token>" }
    const candidatesAgg = new Map<string, { wallet_id: string; tx_hash: string; amount: number; block_time: string }>();
    let totalScanned = 0;

    for (const w of wallets) {
      const walletId = (w as any).id as string;
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
          cursor: cursor,
        });

        const recs: any[] = out?._embedded?.records || [];
        if (recs.length === 0) break;

        for (const r of recs) {
          // only native asset incoming payments
          if (r?.type !== "payment") continue;
          if (String(r?.to || "") !== account) continue;
          if (r?.asset_type !== "native") continue;

          // amount is string in XLM units
          const amt = Number(r?.amount);
          if (!Number.isFinite(amt) || amt <= 0) continue;

          const txHash = String(r?.transaction_hash || "");
          if (!txHash) continue;

          const createdAt = String(r?.created_at || new Date().toISOString());

          // aggregate per (tx_hash, wallet_id) in case multiple ops in same tx to same wallet occur
          const key = `${txHash}:${walletId}`;
          const prev = candidatesAgg.get(key);
          if (prev) prev.amount += amt;
          else candidatesAgg.set(key, { wallet_id: walletId, tx_hash: txHash, amount: amt, block_time: createdAt });

          lastPagingToken = String(r?.paging_token || "") || lastPagingToken;
          totalScanned++;
        }

        // move page
        pages++;
        if (recs.length < PAGE_LIMIT) break; // last page
        // set cursor to last paging token to continue forward
        cursor = String(recs[recs.length - 1]?.paging_token || "") || cursor;
        if (!cursor) break;
      }

      // save cursor per wallet if we progressed
      if (lastPagingToken) {
        await sb.from("settings").upsert(
          { key: cursorKey, value: { cursor: lastPagingToken } },
          { onConflict: "key" }
        );
      }
    }

    const candidates = Array.from(candidatesAgg.values());

    // 3) De-dup by (tx_hash, wallet_id)
    let existingKeys = new Set<string>();
    if (candidates.length) {
      const uniqHashes = Array.from(new Set(candidates.map((r) => r.tx_hash)));
      const { data: ex } = await sb
        .from("contributions")
        .select("tx_hash, wallet_id")
        .in("tx_hash", uniqHashes);
      existingKeys = new Set((ex || []).map((e: any) => `${e.tx_hash}:${e.wallet_id}`));
    }
    const rows = candidates.filter((r) => !existingKeys.has(`${r.tx_hash}:${r.wallet_id}`));

    if (rows.length) {
      const { error: insErr } = await sb.from("contributions").insert(rows);
      if (insErr) throw insErr;
    }

    return NextResponse.json({
      ok: true,
      chain: "XLM",
      wallets: wallets.length,
      scanned_ops: totalScanned,
      candidates: candidates.length,
      inserted: rows.length,
      pages_per_wallet_cap: MAX_PAGES,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "XLM contrib ingest failed" }, { status: 500 });
  }
}

