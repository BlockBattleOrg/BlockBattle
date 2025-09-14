// app/(public)/viz/3d/page.tsx
// Live 3D viz with client-side fetch + color legend (tooltip is anchored in 3D inside BlocksWorld).

"use client";

import { useEffect, useMemo, useState } from "react";
import NextDynamic from "next/dynamic";

const BlocksWorld = NextDynamic(() => import("@/components/three/BlocksWorld"), {
  ssr: false,
});

type ApiRow = {
  chain: string;
  symbol?: string | null;
  amount?: number | null;
  amount_usd?: number | null;
  tx: string;
  timestamp?: string | null;
  note?: string | null;
};

type SceneDatum = {
  id: string;         // tx hash
  amountUsd: number;
  chain: string;
};

// Community Blocks colors (lowercase keys)
const CHAIN_COLORS: Record<string, string> = {
  eth: "#3b82f6",
  btc: "#f59e0b",
  doge: "#b45309",
  ltc: "#2563eb",
  matic: "#7c3aed",
  pol: "#7c3aed",
  bsc: "#f59e0b",
  avax: "#ef4444",
  sol: "#9333ea",
  trx: "#ef4444",
  xlm: "#10b981",
  xrp: "#0ea5e9",
  arb: "#1d4ed8",
  op: "#ef4444",
};

function normChain(x: string | null | undefined): string {
  const s = (x ?? "").toLowerCase();
  if (s === "matic") return "pol";
  if (s === "bnb") return "bsc";
  return s;
}
function toAmountUsd(row: ApiRow): number {
  const v = row.amount_usd ?? row.amount ?? 0;
  return Math.max(0.01, Number(v) || 0.01);
}

export default function Page3D() {
  const [data, setData] = useState<SceneDatum[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/public/contributions/recent", { cache: "no-store" });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = (await res.json()) as { rows: ApiRow[] };
        const rows = Array.isArray(json?.rows) ? json.rows : [];

        const mapped: SceneDatum[] = rows.map((r, idx) => ({
          id: r.tx || `row-${idx}`,
          amountUsd: toAmountUsd(r),
          chain: normChain(r.chain),
        }));

        if (!cancelled) setData(mapped);
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "Failed to load data");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Legend shows only chains present in current dataset (stable order)
  const legend = useMemo(() => {
    if (!data || data.length === 0) return [];
    const seen = new Set<string>();
    const ordered: { chain: string; color: string }[] = [];
    for (const d of data) {
      const key = d.chain.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        ordered.push({ chain: key, color: CHAIN_COLORS[key] ?? "#4b5563" });
      }
    }
    return ordered;
  }, [data]);

  return (
    <main className="min-h-screen w-full bg-white text-black">
      <section className="mx-auto max-w-7xl px-4 py-6">
        <header className="mb-4 flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">BlockBattle — 3D Viz (Live)</h1>
          <p className="text-sm text-gray-600">
            Orbit with mouse/trackpad. Hover a block to see details.
          </p>
        </header>

        <div className="relative h-[70vh] w-full overflow-hidden rounded-2xl border border-gray-200 bg-white">
          {error && (
            <div className="p-6 text-sm text-red-600">Failed to load data: {error}</div>
          )}
          {!error && !data && <div className="p-4 text-sm">Loading 3D scene…</div>}
          {!error && data && data.length === 0 && (
            <div className="p-6 text-sm text-gray-600">No contributions yet.</div>
          )}

          {!error && data && data.length > 0 && (
            <BlocksWorld data={data} colorMap={CHAIN_COLORS} />
          )}
        </div>

        {/* Color legend */}
        {legend.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-gray-700">
            {legend.map((l) => (
              <div key={l.chain} className="flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 rounded-full border border-black/10"
                  style={{ backgroundColor: l.color }}
                  title={l.chain.toUpperCase()}
                />
                <span className="uppercase">{l.chain}</span>
              </div>
            ))}
          </div>
        )}

        <footer className="mt-4 text-xs text-gray-600">
          <p>Data source: /api/public/contributions/recent · Colors aligned with Community Blocks.</p>
        </footer>
      </section>
    </main>
  );
}

