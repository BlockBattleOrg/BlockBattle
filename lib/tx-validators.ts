// lib/tx-validators.ts

export type SupportedChain =
  | 'eth' | 'op' | 'arb' | 'pol' | 'avax' | 'bsc'
  | 'btc' | 'ltc' | 'doge'
  | 'dot'
  | 'atom'
  | 'xrp'
  | 'sol'
  | 'xlm'
  | 'trx';

const EVM_CHAINS = new Set<SupportedChain>(['eth', 'op', 'arb', 'pol', 'avax', 'bsc']);
const U64_HEX_CHAINS = new Set<SupportedChain>(['btc', 'ltc', 'doge', 'atom', 'xrp', 'xlm', 'trx']);
const ZEROX_U64_HEX_CHAINS = new Set<SupportedChain>(['dot']); // Polkadot: 0x + 64 hex
const SOL_CHAIN = 'sol';

const RE_0X64 = /^0x[0-9a-fA-F]{64}$/;
const RE_64 = /^[0-9a-fA-F]{64}$/;
// Solana signatures are base58, ~43–88 chars
const RE_SOL = /^[1-9A-HJ-NP-Za-km-z]{43,88}$/;

export function normalizeChain(input: string): SupportedChain | null {
  const c = input.trim().toLowerCase();
  switch (c) {
    case 'eth': case 'ethereum': return 'eth';
    case 'op': case 'optimism': return 'op';
    case 'arb': case 'arbitrum': return 'arb';
    case 'pol': case 'polygon': case 'matic': return 'pol';
    case 'avax': case 'avalanche': return 'avax';
    case 'bsc': case 'bnb': return 'bsc';
    case 'btc': case 'bitcoin': return 'btc';
    case 'ltc': case 'litecoin': return 'ltc';
    case 'doge': case 'dogecoin': return 'doge';
    case 'dot': case 'polkadot': return 'dot';
    case 'atom': case 'cosmos': return 'atom';
    case 'xrp': case 'ripple': return 'xrp';
    case 'sol': case 'solana': return 'sol';
    case 'xlm': case 'stellar': return 'xlm';
    case 'trx': case 'tron': return 'trx';
    default: return null;
  }
}

export function validateTxHash(chain: SupportedChain, tx: string): { ok: true } | { ok: false; reason: string } {
  if (EVM_CHAINS.has(chain)) return RE_0X64.test(tx) ? { ok: true } : { ok: false, reason: 'expect_0x64_hex' };
  if (U64_HEX_CHAINS.has(chain)) return RE_64.test(tx) ? { ok: true } : { ok: false, reason: 'expect_64_hex' };
  if (ZEROX_U64_HEX_CHAINS.has(chain)) return RE_0X64.test(tx) ? { ok: true } : { ok: false, reason: 'expect_0x64_hex' };
  if (chain === SOL_CHAIN) return RE_SOL.test(tx) ? { ok: true } : { ok: false, reason: 'expect_base58_signature' };
  return { ok: false, reason: 'unsupported_chain' };
}

