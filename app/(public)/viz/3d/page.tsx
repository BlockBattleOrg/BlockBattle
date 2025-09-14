// app/(public)/viz/3d/page.tsx
// Public 3D visualization page (Level 1 MVP).
// - Dynamically loads the r3f scene to avoid SSR issues.
// - Provides a minimal layout and passes mock data (can be replaced with real API data).
// - Keep page-level code minimal; most logic lives in BlocksWorld component.

import dynamic from "next/dynamic";
import { Suspense } from "react";

// IMPORTANT: Dynamic import with `ssr: false` ensures WebGL runs only on client.
const BlocksWorld = dynamic(() => import("@/components/three/BlocksWorld"), {
  ssr: false,
  // Optionally, you can provide a loading component here.
});

export const dynamic = "force-dynamic";

type MockDatum = {
  id: string;
  amountUsd: number; // used to scale/colour cubes
  chain: string;     // just a label for now
};

// Simple mock data to verify the scene renders.
// Replace with a real fetch to /api/public/contributions/leaderboard or recent if desired.
function makeMockData(count = 400): MockDatum[] {
  const chains = ["btc", "eth", "pol", "op", "arb", "avax", "xrp", "sol", "xlm", "doge", "ltc", "bsc"];
  return Array.from({ length: count }).map((_, i) => ({
    id: `item-${i}`,
    amountUsd: Math.max(1, Math.round(Math.random() * 1000)), // 1..1000 USD
    chain: chains[i % chains.length],
  }));
}

export default function Page3D() {
  // NOTE: For production, replace this with data from your public API.
  const data = makeMockData(800);

  return (
    <main className="min-h-screen w-full bg-black text-white">
      <section className="mx-auto max-w-7xl px-4 py-6">
        <header className="mb-4 flex items-baseline justify-between">
          <h1 className="text-2xl font-semibold tracking-tight">BlockBattle — 3D Viz (MVP)</h1>
          <p className="text-sm opacity-75">Orbit the scene with mouse/trackpad. Hover a block to highlight.</p>
        </header>

        {/* Canvas is inside Suspense for lazy-loaded drei assets if needed */}
        <div className="relative h-[70vh] w-full overflow-hidden rounded-2xl border border-white/10">
          <Suspense fallback={<div className="p-4 text-sm">Loading 3D scene…</div>}>
            <BlocksWorld data={data} />
          </Suspense>
        </div>

        <footer className="mt-4 text-xs opacity-60">
          <p>
            This is a minimal proof-of-concept. Next steps: wire to public API, add color mapping by chain, and camera tours.
          </p>
        </footer>
      </section>
    </main>
  );
}

