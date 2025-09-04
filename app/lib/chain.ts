// app/lib/chain.ts
// Canonical chain aliasing for the whole app.
// Use this everywhere instead of ad-hoc alias maps.
//
// Example:
//   import { canonChain, EVM_CHAINS } from "@/lib/chain";
//   const chain = canonChain(input); // "BNB" for "bsc"/"bnb"/"binance"

export type Canon =
  | "BTC" | "ETH" | "POL" | "BNB" | "SOL"
  | "ARB" | "OP" | "AVAX" | "ATOM" | "DOT"
  | "LTC" | "TRX" | "XLM" | "XRP" | "DOGE";

const ALIAS_TO_CANON: Record<string, Canon> = {
  // BTC
  btc: "BTC", bitcoin: "BTC",
  // ETH
  eth: "ETH", ethereum: "ETH",
  // POL / MATIC / POLYGON
  pol: "POL", matic: "POL", polygon: "POL",
  // BNB / BSC / BINANCE
  bnb: "BNB", bsc: "BNB", binance: "BNB",
  // SOL
  sol: "SOL", solana: "SOL",
  // ARB
  arb: "ARB", arbitrum: "ARB",
  // OP
  op: "OP", optimism: "OP",
  // AVAX
  avax: "AVAX", avalanche: "AVAX",
  // ATOM
  atom: "ATOM", cosmos: "ATOM",
  // DOT
  dot: "DOT", polkadot: "DOT",
  // LTC
  ltc: "LTC", litecoin: "LTC",
  // TRX
  trx: "TRX", tron: "TRX",
  // XLM
  xlm: "XLM", stellar: "XLM",
  // XRP
  xrp: "XRP", ripple: "XRP",
  // DOGE
  doge: "DOGE", dogecoin: "DOGE",
};

export function canonChain(x?: string | null): Canon | undefined {
  if (!x) return undefined;
  const low = x.trim().toLowerCase();
  return ALIAS_TO_CANON[low] ?? (x.trim().toUpperCase() as Canon);
}

// EVM chains you likely want to include in loops/workflows (block scanners, etc.)
export const EVM_CHAINS: Canon[] = ["ETH", "POL", "BNB", "ARB", "OP", "AVAX"];

