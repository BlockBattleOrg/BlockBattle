// app/api/ingest/contrib/sol/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const RPC = (process.env.SOL_RPC_URL || "").trim();
const KEY = (process.env.NOWNODES_API_KEY || "").trim();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

const PAGES = Number(process.env.SOL_CONTRIB_PAGES || 2); // pages per wallet
const PAGE_LIMIT = 100; // getSignaturesForAddress limit

type Json = any;

type SignatureInfo = {
  signature: string;
  slot?: number;
  blockTime?: number | null;
  err?: any;
  memo?: string | null;
  confirmationStatus?: string;
};

type ParsedTx = {
  blockTime?: number | null;
  transaction?: {
    message?: {
      accountKeys?: Array<string | { pubkey: string }>;
    };
  };
  meta?: {
    preBalances?: number[];
    postBalances?: number[];
  };
};

function isSOL(symbol?: string | null, chain?: string | null) {
  const s = String(symbol || "").trim().toUpperCase();
  const c = String(chain || "").trim().toUpperCase();
  return s === "SOL" || c === "SOL" || c === "SOLANA";
}
function relFirst<T = any>(maybe: any): T | undefined {
  if (!maybe) return undefined;
  return Array.isArray(maybe) ? maybe[0] : maybe;
}

async function rpc<T = Json>(method: string, params: any[]): Promise<T> {
  if (!RPC) throw new Error("Missing SOL_RPC_URL");
  if (!KEY) throw new Error("Missing NOWNODES_API_KEY");
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": KEY },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`SOL RPC HTTP ${res.status} ${res.statusText}${txt ? `: ${txt}` : ""}`);
  }
  const json = (await res.json()) as any;
  if (json.error) throw new Error(String(json.error?.message || "RPC error"));
  return json.result as T;
}

function toSol(lamports: number) {
  return lamports / 1_000_000_000; // 1e9
}

function keyToString(k: any): string {
  return typeof k === "string" ? k : String(k?.pubkey || "");
}

function accountIndexFromKeys(keys: any[], account: string): number {
  for (let i = 0; i < (keys || []).length; i++) {
    const pk = keyToString(keys[i]);
    if (pk === account) return i;
  }
  return -1;
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

    // 1) Active SOL wallets
    const { data: walletsAll, error: wErr } = await sb
      .from("wallets")
      .select(`
        id, address, chain, is_active, currency_id,
        currencies:currency_id ( symbol )
      `)
      .eq("is_active", true);
    if (wErr) throw wErr;

    const wallets = (walletsAll || []).filter((w: any) => w?.address && isSOL(relFirst(w?.currencies)?.symbol, w?.chain));
    if (wallets.length === 0) {
      return NextResponse.json({ ok: true, info: "No SOL wallets active; nothing to ingest.", inserted: 0 });
    }

    const candidates: Array<{ wallet_id: string; tx_hash: string; amount: number; block_time: string }> = [];
    let scanned = 0;

    for (const w of wallets) {
      const walletId = String((w as any).id);
      const account = String((w as any).address).trim();
      if (!account) continue;

      let before: string | undefined = undefined;

      for (let page = 0; page < PAGES; page++) {
        // Newest-first page
        const sigs: SignatureInfo[] = await rpc<SignatureInfo[]>("getSignaturesForAddress", [
          account,
          { limit: PAGE_LIMIT, before },
        ]);
        if (!Array.isArray(sigs) || sigs.length === 0) break;

        for (const s of sigs) {
          scanned++;
          const signature = String(s?.signature || "");
          if (!signature) continue;

          // getTransaction with jsonParsed
          const tx: ParsedTx | null = await rpc<ParsedTx | null>("getTransaction", [
            signature,
            { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
          ]);
          if (!tx) continue;

          const keys = tx?.transaction?.message?.accountKeys || [];
          const idx = accountIndexFromKeys(keys, account);
          if (idx < 0) continue;

          const pre = Number(tx?.meta?.preBalances?.[idx] ?? 0);
          const post = Number(tx?.meta?.postBalances?.[idx] ?? 0);
          const delta = post - pre;

          // Only positive net inflow (received SOL)
          if (delta > 0) {
            const whenSec = Number(tx?.blockTime ?? s?.blockTime ?? 0) || Math.floor(Date.now() / 1000);
            const whenIso = new Date(whenSec * 1000).toISOString();

            candidates.push({
              wallet_id: walletId,
              tx_hash: signature,
              amount: toSol(delta),
              block_time: whenIso,
            });
          }
        }

        // prepare next page (older)
        before = String(sigs[sigs.length - 1]?.signature || "") || before;
        if (!before) break;
        if (sigs.length < PAGE_LIMIT) break;
      }
    }

    // 2) De-dup by (tx_hash, wallet_id)
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
      chain: "SOL",
      wallets: wallets.length,
      scanned_signatures: scanned,
      candidates: candidates.length,
      inserted: rows.length,
      pages_per_wallet: PAGES,
      page_limit: PAGE_LIMIT,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "SOL contrib ingest failed" }, { status: 500 });
  }
}

