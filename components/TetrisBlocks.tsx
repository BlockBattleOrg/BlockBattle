"use client";

/**
 * TetrisBlocks.tsx
 * Lightweight, “tetris-like” blocks renderer used on the homepage.
 * - One square = one contribution
 * - Bigger amount (USD) => bigger block (with sane clamps)
 * - Smooth falling-in animation with a tiny bounce
 *
 * Expected input shape matches /api/public/blocks/recent.
 */

import * as React from "react";

export type BlockRow = {
  chain: string;                 // e.g. "ETH", "SOL"
  amount: number | null;         // native amount (unused for sizing but shown in title)
  amount_usd?: number | null;    // used for sizing (preferred)
  tx?: string | null;            // optional (for title)
  timestamp?: string | null;     // optional (for title)
};

type Props = {
  rows: BlockRow[];
  columns?: number; // grid columns
};

/** Brand/legend colors MUST match BlocksContainer legend to stay consistent */
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

/** Map USD amount → block scale (1.0 … 2.5) with soft log curve */
function sizeFromUsd(usd?: number | null): number {
  const val = typeof usd === "number" && isFinite(usd) ? usd : 0;
  // Small amounts still visible; large amounts don’t explode the grid.
  // 0 → 1.0, 1 → ~1.3, 10 → ~2.0, 100+ → ~2.5 (clamped)
  const scaled = 1.0 + Math.log10(1 + val) * 0.9;
  return Math.max(1.0, Math.min(2.5, scaled));
}

/** Shorten a hash in tooltip */
function shortHash(tx?: string | null) {
  if (!tx) return "";
  return `${tx.slice(0, 8)}…${tx.slice(-6)}`;
}

export default function TetrisBlocks({ rows, columns = 10 }: Props) {
  // Base square size in px (will be scaled)
  const BASE = 18;

  return (
    <div className="relative">
      {/* Grid container */}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {rows.map((r, idx) => {
          const chain = (r.chain || "").toUpperCase();
          const color = colorForChain(chain);
          const s = sizeFromUsd(r.amount_usd);
          const px = Math.round(BASE * s);

          const title = [
            `Chain: ${chain}`,
            r.amount != null ? `Amount: ${r.amount}` : null,
            r.amount_usd != null ? `≈ ${r.amount_usd.toFixed(4)} USD` : null,
            r.tx ? `Tx: ${shortHash(r.tx)}` : null,
            r.timestamp ? `Time: ${r.timestamp}` : null,
          ]
            .filter(Boolean)
            .join(" • ");

          return (
            <div
              key={r.tx ? `${r.tx}-${idx}` : `b-${idx}`}
              title={title}
              className="relative isolate rounded-md shadow-sm animate-bb-fall will-change-transform"
              style={{
                width: px,
                height: px,
                backgroundColor: color,
                // small variety so multiple blocks don’t fall exactly in sync
                animationDelay: `${(idx % 8) * 60}ms`,
              }}
            />
          );
        })}
      </div>

      {/* Local styles once per component instance */}
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
      `}</style>
    </div>
  );
}

