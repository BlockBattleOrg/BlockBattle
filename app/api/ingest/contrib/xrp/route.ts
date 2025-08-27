// app/api/ingest/contrib/xrp/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const RPC = (process.env.XRP_RPC_URL || "").trim();
const KEY = (process.env.NOWNODES_API_KEY || "").trim();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

// Limit how many ledgers we try to cover in one run (safety cap)
const LEDGER_SPAN = Number(process.env.XRP_CONTRIB_SPAN || 50000); // ~3-5s per ledger

type Json = any;

function isXRP(symbol?: string | null, chain?: string | null) {
  const s = String(symbol || "").trim().toUpperCase();
  const c = String(chain || "").trim().toUpperCase().replace(/\s+/g, "");
  return s === "XRP" || c === "XRP" || c === "RIPPLE";
}

function relFirst<T = any>(maybe: any): T | undefined {
  if (!maybe) return undefined;
  return Array.isArray(maybe) ? maybe[0] : maybe;
}

// XRPL JSON-RPC uses {"method": "...", "params":[{...}]}
async function xrplRpc<T = any>(method: string, paramsObj: Record<string, any>): Promise<T> {
  if (!RPC) throw new Error("Missing XRP_RPC_URL");
  if (!KEY) throw new Error("Missing NOWNODES_API_KEY");

  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": KEY },
    body: JSON.stringify({ method, params: [paramsObj] }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`XRP RPC HTTP ${res.status} ${res.statusText}${txt ? `: ${txt}` : ""}`);
  }
  const json = (await res.json()) as any;
  const result = json?.result;
  if (!result) throw new Error("XRP RPC malformed response");
  if (result?.error) throw new Error(String(result?.error_exception || result?.error_message || result?.error));
  return result as T;
}

// Ripple epoch (2000-01-01) to Unix epoch
function rippleToUnixSeconds(rippleSeconds?: number) {
  if (!rippleSeconds || !Number.isFinite(rippleSeconds)) return 0;
  return rippleSeconds + 946_684_800;
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

    // 1) active XRP wallets
    const { data: walletsAll, error: wErr } = await sb
      .from("wallets")
      .select(`
        id, address, chain, is_active, currency_id,
        currencies:currency_id ( symbol )
      `)
      .eq("is_active", true);
    if (wErr) throw wErr;

    const wallets = (walletsAll || []).filter((w: any) => w?.address && isXRP(relFirst(w?.currencies)?.symbol, w?.chain));
    if (wallets.length === 0) {
      return NextResponse.json({ ok: true, info: "No XRP wallets active; nothing to ingest.", inserted: 0 });
    }

    // 2) get latest validated ledger index
    const led = await xrplRpc<any>("ledger", { ledger_index: "validated" });
    const latest: number = Number(led?.ledger_index || led?.ledger?.ledger_index);
    if (!Number.isFinite(latest)) throw new Error("Failed to resolve latest validated ledger_index");

    // state cursor
    const KEY_MARKER = "xrp_contrib_last_ledger";
    const { data: sRow } = await sb.from("settings").select("value").eq("key", KEY_MARKER).maybeSingle();
    const last = Number((sRow as any)?.value?.n ?? NaN);

    const startBase = Number.isFinite(last) ? last : Math.max(0, latest - LEDGER_SPAN);
    const from = Math.max(0, startBase + 1);
    const to = Math.min(latest, from + LEDGER_SPAN - 1);
    const scannedLedgers = to >= from ? (to - from + 1) : 0;

    // 3) per-wallet scan via account_tx (forward pagination)
    const candidates: Array<{ wallet_id: string; tx_hash: string; amount: number; block_time: string }> = [];

    for (const w of wallets) {
      const account = String((w as any).address).trim();

      let marker: any = undefined;
      // we page until we pass `to` or run out of txs
      while (true) {
        const req: any = {
          account,
          ledger_index_min: from,
          ledger_index_max: to,
          binary: false,
          forward: true,
          limit: 200,
        };
        if (marker) req.marker = marker;

        const out = await xrplRpc<any>("account_tx", req);

        const txs: any[] = Array.isArray(out?.transactions) ? out.transactions : [];
        for (const item of txs) {
          const tx = item?.tx;
          const meta = item?.meta;

          if (!tx || !meta) continue;
          if (tx?.TransactionType !== "Payment") continue;
          if (String(tx?.Destination || "") !== account) continue;
          if (meta?.TransactionResult !== "tesSUCCESS") continue;

          // Only native XRP (drops) as string; skip issued currencies (object)
          if (typeof tx?.Amount !== "string") continue;

          const drops = Number(tx.Amount);
          if (!Number.isFinite(drops) || drops <= 0) continue;

          const hash = String(tx?.hash || "");
          if (!hash) continue;

          const rippleSec = Number(tx?.date || 0);
          const unixSec = rippleToUnixSeconds(rippleSec) || Math.floor(Date.now() / 1000);
          const whenIso = new Date(unixSec * 1000).toISOString();

          const amountXrp = drops / 1_000_000; // 1e6 drops = 1 XRP

          candidates.push({
            wallet_id: (w as any).id,
            tx_hash: hash,
            amount: amountXrp,
            block_time: whenIso,
          });
        }

        marker = out?.marker;
        // stop if no more pages
        if (!marker) break;

        // safety: XRPL can return tx outside range if reorg/edge; break if exceeded
        // (account_tx should respect range, but we keep a guard)
        const maxSeen = Number(out?.ledger_index_max ?? to);
        if (maxSeen >= to) {
          // we paged to or beyond our upper bound
          if (!txs.length) break;
        }
      }
    }

    // 4) de-dup per (tx_hash, wallet_id)
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

    // 5) advance cursor
    await sb.from("settings").upsert({ key: KEY_MARKER, value: { n: to } }, { onConflict: "key" });

    return NextResponse.json({
      ok: true,
      chain: "XRP",
      latest,
      from,
      to,
      scanned_ledgers: scannedLedgers,
      found: candidates.length,
      inserted: rows.length,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "XRP contrib ingest failed" }, { status: 500 });
  }
}

