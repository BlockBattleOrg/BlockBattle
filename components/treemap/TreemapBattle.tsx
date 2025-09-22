// components/treemap/TreemapBattle.tsx
// Treemap “battle” view (Top N) via /api/public/treemap?period=all&limit=5

"use client";

import { useEffect, useState } from "react";
import { ResponsiveContainer, Treemap, Tooltip } from "recharts";
import type { Payload } from "recharts/types/component/DefaultTooltipContent";

type Item = {
  symbol: string;
  amountUsd: number;
  amountNative: number;
  txCount: number;
};

/** Chain colors aligned with Community Blocks (UPPERCASE keys). */
const CHAIN_COLORS: Record<string, string> = {
  ETH: "#3b82f6",
  BTC: "#f59e0b",
  DOGE: "#b45309",
  LTC: "#2563eb",
  MATIC: "#7c3aed",
  POL: "#7c3aed",
  /** Binance mapping: many APIs return BNB (symbol) — keep both keys identical */
  BNB: "#f59e0b",
  BSC: "#f59e0b",
  AVAX: "#ef4444",
  SOL: "#9333ea",
  TRX: "#ef4444",
  XLM: "#10b981",
  XRP: "#0ea5e9",
  ARB: "#1d4ed8",
  OP:  "#ef4444",
};

function colorFor(symbol: string) {
  return CHAIN_COLORS[symbol?.toUpperCase?.() || ""] ?? "#4b5563";
}

/** Rounded tile renderer (nicer visuals, subtle gutters) */
function RoundedTile(props: any) {
  const {
    x, y, width, height, name, fill,
  } = props;

  // small inner padding to create gutters
  const pad = Math.max(2, Math.min(6, Math.min(width, height) * 0.02));
  const rx = Math.min(10, Math.min(width, height) * 0.15);

  return (
    <g>
      <rect
        x={x + pad}
        y={y + pad}
        width={Math.max(0, width - pad * 2)}
        height={Math.max(0, height - pad * 2)}
        rx={rx}
        ry={rx}
        fill={fill}
        stroke="#ffffff"
        strokeWidth={1}
      />
      {/* label (symbol) */}
      {width > 48 && height > 28 && (
        <text
          x={x + width / 2}
          y={y + height / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#111827"
          fontSize={12}
          fontWeight={600}
          style={{ pointerEvents: "none" }}
        >
          {name}
        </text>
      )}
    </g>
  );
}

export default function TreemapBattle({
  period = "all",
  limit = 5,
}: {
  period?: "7d" | "30d" | "ytd" | "all";
  limit?: number;
}) {
  const [data, setData] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/public/treemap?period=${period}&limit=${limit}`,
          { cache: "no-store" }
        );
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
  }, [period, limit]);

  const labelPeriod =
    period === "all" ? "All time" : period === "ytd" ? "YTD" : period.toUpperCase();

  return (
    <section className="mb-6">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Top {limit} (Treemap, {labelPeriod})</h2>
        <span className="text-xs text-gray-500">Data refreshes daily</span>
      </header>

      {/* Half height vs. previous: compact footer section */}
      <div className="h-[24vh] w-full overflow-hidden rounded-xl border border-gray-200 bg-white">
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
                size: Math.max(0.01, d.amountUsd), // layout key
                fill: colorFor(d.symbol),
                txCount: d.txCount,
                amountUsd: d.amountUsd,
                amountNative: d.amountNative,
              }))}
              dataKey="size"
              nameKey="name"
              aspectRatio={16 / 9}
              stroke="#ffffff"
              isAnimationActive
              content={<RoundedTile />}
            >
              <Tooltip
                // custom tooltip: USD + native + tx
                content={({ payload }: { payload?: readonly Payload<any, any>[] }) => {
                  const p = (payload?.[0] as any)?.payload;
                  if (!p) return null;
                  return (
                    <div className="rounded-md border border-gray-200 bg-white px-3 py-2 text-xs shadow-sm">
                      <div className="font-medium">{p.name}</div>
                      <div>
                        USD:{" "}
                        {(Number(p.amountUsd) || 0).toLocaleString(undefined, {
                          style: "currency",
                          currency: "USD",
                          maximumFractionDigits: 2,
                        })}
                      </div>
                      <div>
                        Native:{" "}
                        {(Number(p.amountNative) || 0).toLocaleString(undefined, {
                          maximumFractionDigits: 6,
                        })}{" "}
                        {p.name}
                      </div>
                      <div>Tx: {p.txCount}</div>
                    </div>
                  );
                }}
              />
            </Treemap>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}

