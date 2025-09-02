"use client";

/**
 * TetrisBlocks.tsx
 * One square = one contribution.
 * Bigger USD amount => bigger square (soft log scaling).
 * Each square links to the appropriate chain explorer (if tx is present).
 * Includes a subtle hover (scale + ring). Pointer cursor only when link exists.
 */

import * as React from "react";

export type BlockRow = {
  chain: string;                 // e.g. "ETH", "SOL", "POL" ...
  amount: number | null;         // native amount (for tooltip)
  amount_usd?: number | null;    // used for sizing
  tx?: string | null;            // transaction hash (for explorer link)
  timestamp?: string | null;     // ISO string (for tooltip)
};

type Props = {
  rows: BlockRow[];
  columns?: number; // grid columns (default 10)
};

/** Keep colors aligned with BlocksContainer legend. */
const CHAIN_COLORS: Record<string, string> = {
  ETH: "#3b82f6",
  BTC: "#f59e0b",
  DOGE: "#b45309",
  LTC: "#2563eb",
  MATIC: "#7c3aed",
  POL: "#7c3aed",
  BSC: "#f59e0b",
  AVAX: "#ef4444",
  SOL: "#9333ea",
  TRX: "#ef4444",
  XLM: "#10b981",
  XRP: "#0ea5e9",
  DOT: "#111827",
  ATOM: "#111827",
  ARB: "#1d4ed8",
  OP: "#ef4444",
};

function colorForChain(symbol: string) {
  const key = (symbol || "").toUpperCase();
  return CHAIN_COLORS[key] || "#64748b";
}

/** Map USD -> block scale (1.0 … 2.5) using a gentle log curve. */
function sizeFromUsd(usd?: number | null): number {
  const val = typeof usd === "number" && isFinite(usd) ? usd : 0;
  const scaled = 1.0 + Math.log10(1 + val) * 0.9; // 0→1.0, 1→~1.3, 10→~2.0, 100→~2.5
  return Math.max(1.0, Math.min(2.5, scaled));
}

/** Build a block-explorer URL per chain. */
function explorerTxUrl(chain?: string | null, tx?: string | null) {
  if (!chain || !tx) return null;
  const c = chain.toUpperCase();

  // EVM family
  if (c === "ETH") return `https://etherscan.io/tx/${tx}`;
  if (c === "BSC") return `https://bscscan.com/tx/${tx}`;
  if (c === "ARB") return `https://arbiscan.io/tx/${tx}`;
  if (c === "OP")  return `https://optimistic.etherscan.io/tx/${tx}`;
  if (c === "POL" || c === "MATIC") return `https://polygonscan.com/tx/${tx}`;
  if (c === "AVAX") return `https://snowtrace.io/tx/${tx}`;

  // UTXO / others
  if (c === "BTC")  return `https://mempool.space/tx/${tx}`;
  if (c === "LTC")  return `https://blockchair.com/litecoin/transaction/${tx}`;
  if (c === "DOGE") return `https://blockchair.com/dogecoin/transaction/${tx}`;

  // Cosmos & friends
  if (c === "ATOM") return `https://www.mintscan.io/cosmos/tx/${tx}`;
  if (c === "DOT")  return `https://polkadot.subscan.io/extrinsic/${tx}`;
  if (c === "XRP")  return `https://xrpscan.com/tx/${tx}`;
  if (c === "XLM")  return `https://stellarchain.io/transactions/${tx}`;

  // Solana
  if (c === "SOL")  return `https://solscan.io/tx/${tx}`;

  return null;
}

/** Shorten hash for tooltip/title. */
function shortHash(tx?: string | null) {
  if (!tx) return "";
  return `${tx.slice(0, 8)}…${tx.slice(-6)}`;
}

export default function TetrisBlocks({ rows, columns = 10 }: Props) {
  const BASE = 18; // base px for 1.0 scale

  return (
    <div className="relative">
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {rows.map((r, idx) => {
          const chain = (r.chain || "").toUpperCase();
          const color = colorForChain(chain);
          const s = sizeFromUsd(r.amount_usd);
          const px = Math.round(BASE * s);
          const href = explorerTxUrl(chain, r.tx);

          const title = [
            `Chain: ${chain}`,
            r.amount != null ? `Amount: ${r.amount}` : null,
            r.amount_usd != null ? `≈ ${r.amount_usd.toFixed(4)} USD` : null,
            r.tx ? `Tx: ${shortHash(r.tx)}` : null,
            r.timestamp ? `Time: ${r.timestamp}` : null,
          ]
            .filter(Boolean)
            .join(" • ");

          const square = (
            <div
              title={title}
              className={`relative isolate rounded-md shadow-sm animate-bb-fall will-change-transform ${
                href ? "bb-hover bb-pointer" : ""
              }`}
              style={{
                width: px,
                height: px,
                backgroundColor: color,
                animationDelay: `${(idx % 8) * 60}ms`,
              }}
            />
          );

          return (
            <div key={r.tx ? `${r.tx}-${idx}` : `b-${idx}`} className="flex items-center justify-center">
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`${chain} tx ${shortHash(r.tx)}`}
                >
                  {square}
                </a>
              ) : (
                square
              )}
            </div>
          );
        })}
      </div>

      {/* local CSS for fall + hover */}
      <style jsx>{`
        @keyframes bb-fall {
          0% {
            opacity: 0;
            transform: translateY(-20px) scale(0.95);
            filter: drop-shadow(0 0 0 rgba(0, 0, 0, 0));
          }
          75% {
            opacity: 1;
            transform: translateY(0) scale(1.02);
            filter: drop-shadow(0 6px 6px rgba(0, 0, 0, 0.15));
          }
          100% {
            opacity: 1;
            transform: translateY(0) scale(1);
            filter: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.12));
          }
        }
        .animate-bb-fall {
          animation: bb-fall 520ms cubic-bezier(0.2, 0.9, 0.2, 1) both;
        }
        .bb-hover {
          transition: transform 160ms ease, box-shadow 160ms ease;
        }
        .bb-hover:hover {
          transform: translateY(0) scale(1.06);
          box-shadow: 0 0 0 3px rgba(0, 0, 0, 0.08), 0 6px 10px rgba(0, 0, 0, 0.18);
        }
        .bb-pointer { cursor: pointer; }
      `}</style>
    </div>
  );
}

