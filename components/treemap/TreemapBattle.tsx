"use client";

import { useEffect, useState } from "react";
import { ResponsiveContainer, Treemap, Tooltip } from "recharts";

type Item = {
  name: string;   // symbol (e.g., ETH)
  size: number;   // USD amount (tile size)
  fill: string;   // color
  txCount: number;
  native?: number;
  usd?: number;
};

type Props = {
  period?: "30d" | "all";
  limit?: number;
  /** Container height (px). Default 260. */
  height?: number;
  className?: string;
};

/** Colors aligned with Community Blocks (uppercase keys). */
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
  OP:  "#ef4444",
};

function normalizeArray(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.items)) return payload.items;
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

/**
 * TreemapBattle — Top-N treemap driven by /api/public/treemap
 * English-only labels. Smaller footprint for footer section.
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
        const payload = await res.json();
        const json = normalizeArray(payload);

        const items: Item[] = (json || []).map((r: any) => {
          const sym: string = String(r.symbol ?? r.name ?? "UNKNOWN").toUpperCase();
          const usdNum = Number(r.amountUsd ?? r.usd ?? r.size ?? 0);
          const color = r.color || CHAIN_COLORS[sym] || "#64748b";
          return {
            name: sym,
            size: usdNum,
            fill: color,
            txCount: Number(r.txCount ?? r.count ?? 0),
            native: r.native != null ? Number(r.native) : undefined,
            usd: usdNum,
          };
        });

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
            stroke="#1118270d" /* subtle border */
          >
            <Tooltip
              formatter={(value: any, _name: any, props: any) => {
                const p = props?.payload as Item | undefined;
                const usd = typeof p?.usd === "number" ? p!.usd : Number(value) || 0;
                const first = usd.toLocaleString(undefined, {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 2,
                });
                const second =
                  p?.native != null ? `${p.native} ${p.name}` : `${p?.name ?? ""}`;
                return [first, second];
              }}
              labelFormatter={(_label: any, payload: readonly any[]) => {
                const p = payload?.[0]?.payload as Item | undefined;
                return p ? `${p.name} — ${p.txCount} tx` : "";
              }}
            />
          </Treemap>
        </ResponsiveContainer>
      </div>

      {err && <p className="mt-2 text-sm text-red-600">Failed to load: {err}</p>}
    </div>
  );
}

