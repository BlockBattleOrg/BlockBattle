// app/api/public/blocks/recent/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type AnyRow = Record<string, any>;

type BlockRow = {
  id: string;
  chain: string;        // canonical lower-case (e.g., 'eth', 'bsc', 'pol', ...)
  amount_usd: number;   // >= 0
  ts: string;           // ISO timestamp
  tx_hash: string | null;
};

function normalizeChainFromCurrency(meta?: AnyRow, fallback?: string | number | null): string {
  const vRaw =
    (meta?.chain ??
      meta?.symbol ??
      meta?.code ??
      meta?.slug ??
      (fallback != null ? String(fallback) : "")) || "";

  const v = vRaw.toString().trim().toLowerCase();
  if (!v) return "unknown";

  // Common aliases -> canonical keys used in UI
  if (v === "matic" || v === "pol" || v === "polygon") return "pol";
  if (v === "bsc" || v === "bnb" || v === "binance-smart-chain" || v === "binance") return "bsc";
  if (v === "eth" || v === "ethereum") return "eth";
  if (v === "arb" || v === "arbitrum") return "arb";
  if (v === "op" || v === "optimism") return "op";
  if (v === "avax" || v === "avalanche") return "avax";
  if (v === "xrp" || v === "ripple") return "xrp";
  if (v === "xlm" || v === "stellar") return "xlm";
  if (v === "trx" || v === "tron") return "trx";
  if (v === "dot" || v === "polkadot") return "dot";
  if (v === "atom" || v === "cosmos") return "atom";
  if (v === "btc" || v === "bitcoin") return "btc";
  if (v === "ltc" || v === "litecoin") return "ltc";
  if (v === "doge" || v === "dogecoin") return "doge";
  if (v === "sol" || v === "solana") return "sol";

  return v;
}

function normalizeTs(input?: string | null, fallback?: string | null): string {
  const raw = input ?? fallback ?? new Date().toISOString();
  const d = new Date(raw);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function parseLimit(sp: URLSearchParams, def = 200, max = 500): number {
  const v = Number(sp.get("limit") ?? def);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(Math.trunc(v), max);
}

function parseChains(sp: URLSearchParams): string[] | null {
  const chain = sp.get("chain"); // e.g. "eth" or "eth,bsc"
  if (!chain) return null;
  return chain
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Try contributions ordering by a list of candidate columns (first that works)
async function fetchContributions(
  supabase: ReturnType<typeof createClient>,
  limit: number
): Promise<AnyRow[]> {
  const orderCandidates = [
    { col: "timestamp", asc: false },
    { col: "created_at", asc: false },
    { col: "id", asc: false },
  ];

  for (const cand of orderCandidates) {
    const q = supabase.from("contributions").select("*").order(cand.col as any, { ascending: cand.asc === true ? true : false }).limit(limit);
    const { data, error } = await q;
    if (!error) return data ?? [];
    // If the error is "column does not exist", try next; otherwise rethrow
    const msg = String(error.message || "");
    if (!/column .* does not exist/i.test(msg)) {
      throw error;
    }
  }

  // As a last resort: plain select without order
  const { data, error } = await supabase.from("contributions").select("*").limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = parseLimit(url.searchParams, 200, 500);
    const chainsFilter = parseChains(url.searchParams); // optional

    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return NextResponse.json(
        { ok: false, error: "Supabase env missing (URL or SERVICE_ROLE_KEY)" },
        { status: 500 }
      );
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });

    // 1) Fetch recent contributions (robust to schema differences)
    const contribs = await fetchContributions(supabase, limit);

    if (contribs.length === 0) {
      return NextResponse.json({ ok: true, rows: [], count: 0 }, { status: 200 });
    }

    // 2) Collect keys for mapping
    const currencyIds = new Set<string | number>();
    const walletIds = new Set<string | number>();

    for (const r of contribs) {
      if (r.currency_id != null) currencyIds.add(r.currency_id);
      if (r.wallet_id != null) walletIds.add(r.wallet_id);
    }

    // 3) If we lack currency_id for some rows but have wallet_id, fetch wallets to map wallet -> currency_id
    let walletMap = new Map<string | number, AnyRow>();
    if (walletIds.size > 0) {
      const { data: wallets, error: wErr } = await supabase
        .from("wallets")
        .select("*")
        .in("id", Array.from(walletIds));
      if (wErr) {
        // If table/column doesn't exist, continue gracefully
        walletMap = new Map();
      } else {
        walletMap = new Map(wallets.map((w: AnyRow) => [w.id, w]));
        // collect missing currency_ids from wallets
        for (const r of contribs) {
          if (r.currency_id == null && r.wallet_id != null) {
            const w = walletMap.get(r.wallet_id);
            if (w?.currency_id != null) currencyIds.add(w.currency_id);
          }
        }
      }
    }

    // 4) Fetch currencies map (id -> meta) if we have any currency ids; otherwise fetch all (cheap)
    let currencyMap = new Map<string | number, AnyRow>();
    if (currencyIds.size > 0) {
      const { data: currencies, error: cErr } = await supabase
        .from("currencies")
        .select("*")
        .in("id", Array.from(currencyIds));
      if (!cErr) {
        currencyMap = new Map(currencies.map((c: AnyRow) => [c.id, c]));
      }
    } else {
      const { data: currencies, error: cErr } = await supabase
        .from("currencies")
        .select("*");
      if (!cErr) {
        currencyMap = new Map((currencies ?? []).map((c: AnyRow) => [c.id, c]));
      }
    }

    // 5) Build rows
    let rows: BlockRow[] = contribs.map((r: AnyRow) => {
      // amount_usd (fallback to 'amount' or 0)
      const amountUsd =
        typeof r.amount_usd === "number"
          ? r.amount_usd
          : Math.max(0, Number(r.amount ?? 0));

      // timestamp normalization
      const ts = normalizeTs(r.timestamp, r.ts ?? r.created_at);

      // lookup currency via direct currency_id or via wallet_id -> wallet.currency_id
      let currencyId: string | number | null = r.currency_id ?? null;
      if (currencyId == null && r.wallet_id != null) {
        const w = walletMap.get(r.wallet_id);
        if (w?.currency_id != null) currencyId = w.currency_id;
      }

      const meta = currencyId != null ? currencyMap.get(currencyId) : undefined;
      const chain = normalizeChainFromCurrency(meta, currencyId);

      return {
        id: String(r.id),
        chain,
        amount_usd: amountUsd,
        ts,
        tx_hash: r.tx_hash ?? null,
      };
    });

    // Optional filter
    if (chainsFilter && chainsFilter.length > 0) {
      rows = rows.filter((r) => chainsFilter.includes(r.chain));
    }

    return NextResponse.json({ ok: true, rows, count: rows.length }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}

