"use client";

import * as React from "react";

export type BlockRow = {
  id: string;
  chain: string;        // e.g. 'eth', 'bsc', 'pol', ...
  amount_usd: number;   // >= 0
  ts: string;           // ISO timestamp
  tx_hash: string | null;
};

type Props = {
  rows: BlockRow[];
  columns?: number;         // grid width, default 10
  minSize?: number;         // px, minimal block size
  maxSize?: number;         // px, maximal block size
};

const CHAIN_COLORS: Record<string, string> = {
  eth: "#627EEA",
  pol: "#8247E5",
  bsc: "#F3BA2F",
  arb: "#28A0F0",
  op:  "#FF0420",
  avax:"#E84142",
  xrp: "#23292F",
  xlm: "#14B8A6",
  trx: "#C73127",
  dot: "#E6007A",
  atom:"#2E3148",
  btc: "#F7931A",
  ltc: "#345D9D",
  doge:"#C2A633",
  sol: "#14F195",
  unknown: "#9CA3AF",
};

function colorForChain(chain: string) {
  return CHAIN_COLORS[chain] ?? CHAIN_COLORS.unknown;
}

/**
 * Convert contribution USD amount to square block size in px.
 * We use sqrt scaling to avoid a few whales dominating the view.
 */
function sizeForAmount(amountUsd: number, min = 18, max = 72) {
  const safe = Math.max(0, amountUsd);
  // heuristic scaling: sqrt with soft cap
  const scaled = Math.sqrt(safe);     // 0..∞
  // normalize by a reference (e.g. $100 -> ~10), then clamp
  const ref = 10;                      // tweak as needed
  const px = scaled * ref;
  return Math.max(min, Math.min(px, max));
}

export default function TetrisBlocks({
  rows,
  columns = 10,
  minSize = 18,
  maxSize = 72,
}: Props) {
  // Optional: re-order rows so bigger blocks appear first (nicer packing)
  const ordered = React.useMemo(
    () => [...rows].sort((a, b) => b.amount_usd - a.amount_usd),
    [rows]
  );

  return (
    <div className="space-y-4">
      <Legend />

      <div
        className="grid gap-1"
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        }}
      >
        {ordered.map((r) => {
          const size = sizeForAmount(r.amount_usd, minSize, maxSize);
          const bg = colorForChain(r.chain);
          const title = `${r.chain.toUpperCase()} • $${r.amount_usd.toFixed(2)} • ${new Date(r.ts).toLocaleString()}`;
          const href =
            r.tx_hash && r.chain
              ? explorerLink(r.chain, r.tx_hash)
              : null;

          const Block = (
            <div
              key={r.id}
              title={title}
              className="rounded-md shadow-sm transition-transform hover:scale-105"
              style={{
                width: `${size}px`,
                height: `${size}px`,
                background: bg,
              }}
            />
          );

          return (
            <div key={r.id} className="flex items-center justify-center">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${r.chain} tx ${r.tx_hash?.slice(0, 10)}...`}
                >
                  {Block}
                </a>
              ) : (
                Block
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Legend() {
  const entries = Object.entries(CHAIN_COLORS);
  // Hide 'unknown' in legend
  const visible = entries.filter(([k]) => k !== "unknown").slice(0, 12);

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {visible.map(([chain, color]) => (
        <div key={chain} className="flex items-center gap-2">
          <span
            className="inline-block rounded-sm"
            style={{ width: 12, height: 12, background: color }}
          />
          <span className="uppercase">{chain}</span>
        </div>
      ))}
    </div>
  );
}

function explorerLink(chain: string, tx: string) {
  const c = chain.toLowerCase();
  if (c === "eth") return `https://etherscan.io/tx/${tx}`;
  if (c === "pol") return `https://polygonscan.com/tx/${tx}`;
  if (c === "bsc") return `https://bscscan.com/tx/${tx}`;
  if (c === "arb") return `https://arbiscan.io/tx/${tx}`;
  if (c === "op")  return `https://optimistic.etherscan.io/tx/${tx}`;
  if (c === "avax")return `https://snowtrace.io/tx/${tx}`;
  if (c === "trx") return `https://tronscan.org/#/transaction/${tx}`;
  if (c === "dot") return `https://polkadot.subscan.io/extrinsic/${tx}`;
  if (c === "atom")return `https://www.mintscan.io/cosmos/txs/${tx}`;
  if (c === "xrp") return `https://xrpscan.com/tx/${tx}`;
  if (c === "xlm") return `https://stellar.expert/explorer/public/tx/${tx}`;
  if (c === "btc") return `https://mempool.space/tx/${tx}`;
  if (c === "ltc") return `https://litecoinspace.org/tx/${tx}`;
  if (c === "doge")return `https://dogechain.info/tx/${tx}`;
  if (c === "sol") return `https://solscan.io/tx/${tx}`;
  return "#";
}

