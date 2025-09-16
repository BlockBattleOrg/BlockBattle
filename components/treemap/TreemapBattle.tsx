"use client";

import { useEffect, useState } from "react";
import { ResponsiveContainer, Treemap, Tooltip } from "recharts";

type Item = {
  name: string;
  size: number;
  fill: string;
  txCount: number;
  native?: number;
  usd?: number;
};

type Props = {
  period?: "30d" | "all";
  limit?: number;
  /** Visual height in pixels (container). Default: 260 */
  height?: number;
  className?: string;
};

function normalizeArray(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.rows)) return payload.rows;
  if (Array.isArray(payload?.items)) return payload.items;
  // last-resort: if it's a plain object with values that look like rows
  if (payload && typeof payload === "object") return Object.values(payload);
  return [];
}

/**
 * TreemapBattle
 * Renders a Top-N treemap fed by /api/public/treemap.
 * English-only labels.
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

        const items: Item[] = (json || []).map((r: any) => ({
          name: r.symbol ?? r.name ?? "UNKNOWN",
          size: Number(r.amountUsd ?? r.usd ?? r.size ?? 0),
          fill: r.color || "#64748b",
          txCount: Number(r.txCount ?? r.count ?? 0),
          native: r.native,
          usd: Number(r.amountUsd ?? r.usd ?? 0),
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
          <Treemap data={data || []} dataKey="size" aspectRatio={4 / 3} stroke="#ffffff">
            <Tooltip
              formatter={(value: any, _name: any, props: any) => {
                const p = props?.payload as Item | undefined;
                const usd = typeof p?.usd === "number" ? p!.usd : Number(value) || 0;
                const native = p?.native;
                const sym = p?.name || "";
                const first = usd.toLocaleString(undefined, {
                  style: "currency",
                  currency: "USD",
                  maximumFractionDigits: 2,
                });
                const second = native != null ? `${native} ${sym}` : `${sym}`;
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

