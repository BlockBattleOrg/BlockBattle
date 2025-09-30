// lib/chain.ts
// Canonical chain helpers and alias mapping.
//
// Responsibilities:
// - Normalize user-supplied chain identifiers into canonical slugs.
// - Provide sets for EVM vs non-EVM chains.
// - Utility: validate EVM transaction hashes.
// - Exported so all API routes (claim, ingest, public) use same logic.

export type ChainSlug =
  | "eth" | "arb" | "avax" | "op" | "pol" | "bsc"
  | "btc" | "ltc" | "doge" | "xrp" | "xlm" | "sol" | "trx" | "dot" | "atom";

const CANON_MAP: Record<string, ChainSlug> = {
  // --- EVM ---
  eth: "eth",
  ethereum: "eth",
  arb: "arb",
  arbitrum: "arb",
  avax: "avax",
  avalanche: "avax",
  op: "op",
  optimism: "op",
  pol: "pol",
  polygon: "pol",
  matic: "pol",
  bsc: "bsc",
  bnb: "bsc",

  // --- Non-EVM ---
  btc: "btc",
  bitcoin: "btc",
  ltc: "ltc",
  litecoin: "ltc",
  doge: "doge",
  dogecoin: "doge",
  xrp: "xrp",
  ripple: "xrp",
  xlm: "xlm",
  stellar: "xlm",
  sol: "sol",
  solana: "sol",
  trx: "trx",
  tron: "trx",
  dot: "dot",
  polkadot: "dot",
  atom: "atom",
  cosmos: "atom",
};

export const EVM_CHAINS: Set<ChainSlug> = new Set([
  "eth", "arb", "avax", "op", "pol", "bsc",
]);

export function canonChain(input: string | null | undefined): ChainSlug | null {
  if (!input) return null;
  const key = String(input).trim().toLowerCase();
  return CANON_MAP[key] ?? null;
}

export function isEvmChain(c: ChainSlug | null | undefined): boolean {
  return c ? EVM_CHAINS.has(c) : false;
}

export function isValidEvmTxHash(tx: unknown): boolean {
  if (typeof tx !== "string") return false;
  // Must be 0x-prefixed and 64 hex chars
  return /^0x[0-9a-fA-F]{64}$/.test(tx);
}

