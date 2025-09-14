"use client";

import * as React from "react";
import TetrisBlocks, { BlockRow } from "./TetrisBlocks";

type Props = {
  limit?: number;
  refreshMs?: number; // auto-refresh interval
  defaultChain?: string | null; // e.g. "eth" or null = All
};

// Supported chains (All – DOT & ATOM removed)
const CHAIN_OPTIONS = [
  { value: "", label: "All chains" },
  { value: "eth", label: "ETH" },
  { value: "bsc", label: "BSC" },
  { value: "pol", label: "POL" },
  { value: "arb", label: "ARB" },
  { value: "op",  label: "OP"  },
  { value: "avax",label: "AVAX"},
  { value: "xrp", label: "XRP" },
  { value: "xlm", label: "XLM" },
  { value: "trx", label: "TRX" },
  { value: "btc", label: "BTC" },
  { value: "ltc", label: "LTC" },
  { value: "doge",label: "DOGE"},
  { value: "sol", label: "SOL" },
];

// Brand colors per chain (DOT & ATOM removed)
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
  ARB: "#1d4ed8",
  OP: "#ef4444",
};

function colorForChain(symbol: string) {
  const key = symbol.toUpperCase();
  return CHAIN_COLORS[key] || "#64748b"; // fallback gray
}

export default function BlocksContainer({
  limit = 200,
  refreshMs = 60000,
  defaultChain = null,
}: Props) {
  const [rows, setRows] = React.useState<BlockRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [chain, setChain] = React.useState<string>(defaultChain ?? "");

  const fetchOnce = React.useCallback(
    async (signal?: AbortSignal) => {
      try {
        setLoading(true);
        setError(null);
        const base = process.env.NEXT_PUBLIC_BASE_URL ?? "";
        const qs = new URLSearchParams();
        qs.set("limit", String(limit));
        if (chain) qs.set("chain", chain);
        const url = `${base}/api/public/blocks/recent?${qs.toString()}`;
        const res = await fetch(url, { cache: "no-store", signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        setRows((data?.rows ?? []) as BlockRow[]);
      } catch (e: any) {
        if (e?.name === "AbortError") return;
        setError(String(e?.message ?? e));
      } finally {
        setLoading(false);
      }
    },
    [limit, chain]
  );

  // initial + auto refresh
  React.useEffect(() => {
    const ctrl = new AbortController();
    fetchOnce(ctrl.signal);

    const id = window.setInterval(() => {
      const rCtrl = new AbortController();
      fetchOnce(rCtrl.signal);
    }, Math.max(10000, refreshMs));

    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
  }, [fetchOnce, refreshMs]);

  return (
    <section className="space-y-4">
      <Toolbar
        chain={chain}
        onChainChange={setChain}
        loading={loading}
        error={error}
        onRefresh={() => fetchOnce()}
      />

      {/* Legend */}
      <Legend />

      <TetrisBlocks rows={rows} columns={10} />
    </section>
  );
}

function Toolbar(props: {
  chain: string;
  onChainChange: (v: string) => void;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  const { chain, onChainChange, loading, error, onRefresh } = props;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-sm text-gray-600">
        Chain:
        <select
          className="ml-2 rounded-md border px-2 py-1 text-sm"
          value={chain}
          onChange={(e) => onChainChange(e.target.value)}
        >
          {CHAIN_OPTIONS.map((opt) => (
            <option key={opt.value || "all"} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="button"
        onClick={onRefresh}
        className="rounded-md border px-3 py-1 text-sm hover:bg-gray-50 active:scale-[0.99]"
        disabled={loading}
      >
        {loading ? "Refreshing…" : "Refresh now"}
      </button>

      {error ? (
        <span className="text-sm text-red-600">Error: {error}</span>
      ) : (
        <span className="text-sm text-gray-500">
          {loading ? "Loading…" : "View (auto-refreshed from hourly ingestions)"}
        </span>
      )}
    </div>
  );
}

function Legend() {
  const items = CHAIN_OPTIONS.filter((x) => x.value !== "");
  return (
    <div className="flex flex-wrap items-center gap-3">
      {items.map((c) => (
        <div key={c.label} className="flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-sm"
            style={{ backgroundColor: colorForChain(c.label) }}
            aria-hidden
          />
          <span className="text-xs">{c.label}</span>
        </div>
      ))}
    </div>
  );
}

