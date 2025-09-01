// app/api/public/blocks/recent/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

type Contribution = {
  id: string | number;
  currency_id: string | number | null;
  amount_usd: number | null;
  amount?: number | null;   // optional fallback if exists
  timestamp?: string | null;
  ts?: string | null;
  tx_hash?: string | null;
};

type Currency = {
  id: string | number;
  // schema-flexible: try common fields; use what exists
  chain?: string | null;
  symbol?: string | null;
  code?: string | null;
  slug?: string | null;
  name?: string | null;
};

type BlockRow = {
  id: string;
  chain: string;        // canonical lower-case (e.g., 'eth', 'bsc', 'pol', ...)
  amount_usd: number;   // >= 0
  ts: string;           // ISO timestamp
  tx_hash: string | null;
};

function normalizeChain(
  fromCurrencies: Partial<Currency> | undefined,
  fallbackCurrencyId: string | number | null
): string {
  const vRaw =
    (fromCurrencies?.chain ??
      fromCurrencies?.symbol ??
      fromCurrencies?.code ??
      fromCurrencies?.slug ??
      String(fallbackCurrencyId ?? "")) || "";

  const v = vRaw.toString().trim().toLowerCase();
  if (!v) return "unknown";

  // Common aliases
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

function parseLimit(searchParams: URLSearchParams, def = 200, max = 500): number {
  const v = Number(searchParams.get("limit") ?? def);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(Math.trunc(v), max);
}

function parseChains(searchParams: URLSearchParams): string[] | null {
  const chain = searchParams.get("chain"); // e.g. "eth" or "eth,bsc"
  if (!chain) return null;
  return chain
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
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

    // 1) Fetch recent contributions
    const contribQuery = supabase
      .from("contributions")
      .select("id, currency_id, amount_usd, amount, timestamp, ts, tx_hash")
      .order("timestamp", { ascending: false })
      .limit(limit);

    const { data: contribs, error: cErr } = await contribQuery;
    if (cErr) return NextResponse.json({ ok: false, error: cErr.message }, { status: 500 });

    // Early return if nothing
    const list = contribs ?? [];
    if (list.length === 0) {
      return NextResponse.json({ ok: true, rows: [], count: 0 }, { status: 200 });
    }

    // 2) Fetch currencies map
    const { data: currencies, error: curErr } = await supabase
      .from("currencies")
      .select("id, chain, symbol, code, slug, name");
    if (curErr) return NextResponse.json({ ok: false, error: curErr.message }, { status: 500 });

    const cmap = new Map<string | number, Currency>();
    (currencies ?? []).forEach((c) => cmap.set(c.id, c));

    // 3) Build rows with normalized chain & ts
    let rows: BlockRow[] = list.map((r: Contribution) => {
      const meta = r.currency_id != null ? cmap.get(r.currency_id) : undefined;
      const chain = normalizeChain(meta, r.currency_id);
      const amountUsd =
        typeof r.amount_usd === "number"
          ? r.amount_usd
          : Math.max(0, Number(r.amount ?? 0));
      const ts = normalizeTs(r.timestamp, r.ts);
      return {
        id: String(r.id),
        chain,
        amount_usd: amountUsd,
        ts,
        tx_hash: r.tx_hash ?? null,
      };
    });

    // Optional chain filter
    if (chainsFilter && chainsFilter.length > 0) {
      rows = rows.filter((r) => chainsFilter.includes(r.chain));
    }

    return NextResponse.json({ ok: true, rows, count: rows.length }, { status: 200 });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message ?? err) }, { status: 500 });
  }
}

