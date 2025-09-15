// components/treemap/TreemapBattle.tsx
// Treemap “battle” view (Top 15) preko /api/public/treemap?period=30d

"use client";

import { useEffect, useState } from "react";
import { ResponsiveContainer, Treemap, Tooltip } from "recharts";

type Item = { symbol: string; amountUsd: number; txCount: number };

const CHAIN_COLORS: Record<string, string> = {
  ETH: "#3b82f6",
  BTC: "#f59e0b",
  DOGE: "#b45309",
  LTC: "#2563eb",
  MATIC: "#7c3aed",
  POL: "#7c3aed",
  BNB: "#f59e0b",
  AVAX: "#ef4444",
  SOL: "#9333ea",
  TRX: "#ef4444",
  XLM: "#10b981",
  XRP: "#0ea5e9",
  ARB: "#1d4ed8",
  OP: "#ef4444",
};

function colorFor(symbol: string) {
  return CHAIN_COLORS[symbol] ?? "#4b5563";
}

export default function TreemapBattle({ period = "30d" }: { period?: "7d" | "30d" | "ytd" }) {
  const [data, setData] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/treemap?period=${period}`, { cache: "no-store" });
        const json = await res.json();
        if (!cancel) {
          if (json?.ok) setData(json.items as Item[]);
          else setErr(json?.error ?? "Failed to load");
        }
      } catch (e: any) {
        if (!cancel) setErr(String(e?.message || e));
      }
    })();
    return () => {
      cancel = true;
    };
  }, [period]);

  return (
    <section className="mb-6">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Top 15 (Treemap, {period.toUpperCase()})</h2>
        <span className="text-xs text-gray-500">Data refreshes daily</span>
      </header>

      <div className="h-[48vh] w-full overflow-hidden rounded-xl border border-gray-200 bg-white">
        {err && <div className="p-3 text-xs text-red-600">Failed to load: {err}</div>}
        {!err && !data && <div className="p-3 text-xs text-gray-600">Loading treemap…</div>}
        {!err && data && data.length === 0 && (
          <div className="p-3 text-xs text-gray-600">No data available yet.</div>
        )}
        {!err && data && data.length > 0 && (
          <ResponsiveContainer width="100%" height="100%">
            <Treemap
              data={data.map((d) => ({
                name: d.symbol,
                size: Math.max(0.01, d.amountUsd), // Recharts expects positive
                fill: colorFor(d.symbol),
                txCount: d.txCount,
              }))}
              dataKey="size"
              nameKey="name"
              aspectRatio={4 / 3}
              stroke="#ffffff"
              isAnimationActive
            >
              <Tooltip
                formatter={(value: any, name: any) => {
                  if (name === "size") {
                    return [
                      (Number(value) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 }),
                      "USD",
                    ];
                  }
                  return [String(value), name];
                }}
                labelFormatter={(_, payload: any[]) => {
                  const p = payload?.[0]?.payload;
                  if (!p) return "";
                  return `${p.name} — ${p.txCount} tx`;
                }}
              />
            </Treemap>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

