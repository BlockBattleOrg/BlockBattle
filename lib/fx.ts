// lib/fx.ts
// Fetches USD prices for supported symbols and provides helpers to convert native amounts to USD.
// Uses CoinGecko Simple Price API. Optional API key supported via COINGECKO_API_KEY.

import type { SupabaseClient } from "@supabase/supabase-js";

type PriceMap = Record<string, number>; // symbol -> usd price

// Mapping of our symbols -> CoinGecko IDs
const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  POL: "polygon-pos", // MATIC (Polygon PoS)
  OP: "optimism",
  ARB: "arbitrum",
  AVAX: "avalanche-2",
  DOT: "polkadot",
  ATOM: "cosmos",
  XRP: "ripple",
  SOL: "solana",
  XLM: "stellar",
  LTC: "litecoin",
  DOGE: "dogecoin",
  TRX: "tron",
  BSC: "binancecoin", // BNB Smart Chain native
};

const COINGECKO_API_BASE =
  process.env.COINGECKO_API_BASE?.trim() || "https://api.coingecko.com/api/v3";

const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY?.trim() || "";

function unique<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

export async function fetchUsdPrices(symbols: string[]): Promise<PriceMap> {
  const ids = unique(
    symbols
      .map((s) => s.toUpperCase())
      .map((s) => COINGECKO_IDS[s])
      .filter(Boolean)
  );
  if (ids.length === 0) return {};

  const url = new URL(`${COINGECKO_API_BASE}/simple/price`);
  url.searchParams.set("ids", ids.join(","));
  url.searchParams.set("vs_currencies", "usd");
  url.searchParams.set("precision", "full");

  const headers: Record<string, string> = {};
  if (COINGECKO_API_KEY) headers["x-cg-pro-api-key"] = COINGECKO_API_KEY;

  const res = await fetch(url.toString(), { headers, next: { revalidate: 30 } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`FX fetch failed: ${res.status} ${res.statusText} :: ${text}`);
  }
  const data = (await res.json()) as Record<string, { usd: number }>;
  // reverse map: id -> symbol
  const idToSymbol = Object.entries(COINGECKO_IDS).reduce<Record<string, string>>(
    (acc, [symbol, id]) => {
      acc[id] = symbol;
      return acc;
    },
    {}
  );

  const prices: PriceMap = {};
  for (const [id, obj] of Object.entries(data)) {
    const symbol = idToSymbol[id];
    if (symbol && typeof obj?.usd === "number") prices[symbol] = obj.usd;
  }
  return prices;
}

/**
 * Converts a native amount to USD using provided price map and decimals.
 * amountNative is a string (as stored), decimals defines base units.
 */
export function toUsd(
  symbol: string,
  amountNative: string,
  decimals: number,
  prices: PriceMap
): number | null {
  const p = prices[symbol.toUpperCase()];
  if (!p) return null;
  // BigInt-safe manual conversion
  try {
    const [whole, frac = ""] = amountNative.split(".");
    if (frac.length > 0) {
      // normalize to integer base units if amount is decimal string
      const normalized = (whole || "0") + (frac + "0".repeat(Math.max(0, decimals - frac.length))).slice(0, decimals);
      const units = BigInt(normalized || "0");
      const value = Number(units) / 10 ** decimals;
      return value * p;
    } else {
      // amount is already base units (string integer)
      const units = BigInt(amountNative || "0");
      const value = Number(units) / 10 ** decimals;
      return value * p;
    }
  } catch {
    return null;
  }
}

/**
 * Loads currency metadata (symbol, decimals) from Supabase `currencies`.
 */
export async function loadCurrencyMeta(
  supabase: SupabaseClient,
  symbols: string[]
): Promise<Record<string, { decimals: number }>> {
  const { data, error } = await supabase
    .from("currencies")
    .select("symbol, decimals")
    .in("symbol", symbols.map((s) => s.toUpperCase()));

  if (error) throw error;
  const map: Record<string, { decimals: number }> = {};
  for (const row of data || []) {
    map[row.symbol.toUpperCase()] = { decimals: row.decimals ?? 18 };
  }
  return map;
}

