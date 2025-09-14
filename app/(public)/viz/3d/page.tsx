// app/(public)/viz/3d/page.tsx
// Public 3D visualization page (Live) wired to real data.
// - Fetches /api/public/contributions/recent (no-store).
// - Passes normalized data (id, amountUsd, chain) to client Three.js scene.
// - Per-chain color mapping aligned with Community Blocks.

import NextDynamic from "next/dynamic";
import { Suspense } from "react";

const BlocksWorld = NextDynamic(() => import("@/components/three/BlocksWorld"), {
  ssr: false,
});

export const dynamic = "force-dynamic";

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
  id: string;
  amountUsd: number;
  chain: string;
};

// Community Blocks color mapping (provided)
// Note: keys are lowercase; aliases handled in normChain()
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

async function getRecent(): Promise<SceneDatum[]> {
  const res = await fetch("/api/public/contributions/recent", { cache: "no-store" });
  if (!res.ok) {
    // Fallback mini dataset if API is down
    return Array.from({ length: 60 }).map((_, i) => ({
      id: `fallback-${i}`,
      amountUsd: 1 + (i % 100),
      chain: ["btc", "eth", "pol", "op", "arb", "avax", "xrp", "sol", "xlm", "doge", "ltc", "bsc"][i % 12],
    }));
  }
  const json = (await res.json()) as { rows: ApiRow[] };
  const rows = Array.isArray(json?.rows) ? json.rows : [];

  const out: SceneDatum[] = rows.map((r, idx) => ({
    id: r.tx || `row-${idx}`,
    amountUsd: toAmountUsd(r),
    chain: normChain(r.chain),
  }));

  // Optional: upsample to make the scene visually dense (cap at 1200)
  const target = Math.min(1200, Math.max(out.length, 400));
  const cloned: SceneDatum[] = [];
  for (let i = 0; i < target; i++) cloned.push(out[i % out.length]);
  return cloned;
}

export default async function Page3D() {
  const data = await getRecent();

  return (
    <main className="min-h-screen w-full bg-black text-white">
      <section className="mx-auto max-w-7xl px-4 py-6">
        <header className="mb-4 flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">BlockBattle — 3D Viz (Live)</h1>
          <p className="text-sm opacity-75">Orbit with mouse/trackpad. Hover a block to highlight.</p>
        </header>

        <div className="relative h-[70vh] w-full overflow-hidden rounded-2xl border border-white/10">
          <Suspense fallback={<div className="p-4 text-sm">Loading 3D scene…</div>}>
            <BlocksWorld data={data} colorMap={CHAIN_COLORS} />
          </Suspense>
        </div>

        <footer className="mt-4 text-xs opacity-60">
          <p>Data source: /api/public/contributions/recent · Colors aligned with Community Blocks.</p>
        </footer>
      </section>
    </main>
  );
}

