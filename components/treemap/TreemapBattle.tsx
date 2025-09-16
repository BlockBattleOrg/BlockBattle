"use client";

import { useEffect, useState } from "react";
import { ResponsiveContainer, Treemap, Tooltip } from "recharts";

type Item = {
  name: string;         // symbol (e.g., ETH)
  size: number;         // amount in USD (used for block size)
  fill: string;         // color per chain (aligned with Community Blocks)
  txCount: number;      // number of contributions
  native?: number;      // total native amount (optional)
  usd?: number;         // total USD amount (for tooltip)
};

type Props = {
  period?: "30d" | "all";
  limit?: number;
  /** Visual height in pixels (container). Default: 260 */
  height?: number;
  className?: string;
};

/**
 * TreemapBattle
 * Renders a Top-N treemap fed by /api/public/treemap.
 * All strings are English-only by project convention.
 */
export default function TreemapBattle({
  period = "all",
  limit = 5,
  height = 260,
  className,
}: Props) {
  const [data, setData] = useState<Item[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/public/treemap?period=${period}&limit=${limit}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Array<{
          symbol: string;
          amountUsd: number;
          txCount: number;
          color?: string;
          native?: number;
        }>;

        const items: Item[] = (json || []).map((r) => ({
          name: r.symbol,
          size: Number(r.amountUsd ?? 0),
          fill: r.color || "#64748b",
          txCount: Number(r.txCount ?? 0),
          native: r.native,
          usd: Number(r.amountUsd ?? 0),
        }));

        if (alive) {
          setData(items);
          setErr(null);
        }
      } catch (e: any) {
        if (alive) setErr(e?.message || "Failed to load");
      }
    })();
    return () => {
      alive = false;
    };
  }, [period, limit]);

  return (
    <div className={className}>
      <div style={{ width: "100%", height }}>
        <ResponsiveContainer width="100%" height="100%">
          <Treemap
            data={data || []}
            dataKey="size"
            aspectRatio={4 / 3}
            stroke="#ffffff"
          >
            <Tooltip
              formatter={(value: any, _name: any, props: any) => {
                const p = props?.payload as Item | undefined;
                if (!p) return [String(value), "USD"];
                const usd = typeof p.usd === "number" ? p.usd : Number(value) || 0;
                const native = p.native;
                const sym = p.name;
                const first = usd.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
                const second = native != null ? `${native} ${sym}` : `${sym}`;
                return [first, second];
              }}
              labelFormatter={(_label: any, payload) => {
                const p = payload?.[0]?.payload as Item | undefined;
                if (!p) return "";
                // e.g. "ETH — 2 tx"
                return `${p.name} — ${p.txCount} tx`;
              }}
            />
          </Treemap>
        </ResponsiveContainer>
      </div>

      {err && (
        <p className="mt-2 text-sm text-red-600">Failed to load: {err}</p>
      )}
    </div>
  );
}

