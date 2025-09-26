// components/three/Viz3DInline.tsx
// Inline 3D viz to embed above "Community Blocks" (compact, white background).
"use client";

import { useEffect, useState } from "react";
import NextDynamic from "next/dynamic";

// Reuse existing BlocksWorld scene
const BlocksWorld = NextDynamic(() => import("@/components/three/BlocksWorld"), { ssr: false });

type ApiRow = { chain: string; amount?: number | null; amount_usd?: number | null; tx: string };
type SceneDatum = { id: string; amountUsd: number; chain: string };

const CHAIN_COLORS: Record<string, string> = {
  eth: "#3b82f6", btc: "#f59e0b", doge: "#b45309", ltc: "#2563eb",
  matic: "#7c3aed", pol: "#7c3aed", bsc: "#f59e0b",
  avax: "#ef4444", sol: "#9333ea", trx: "#ef4444",
  xlm: "#10b981", xrp: "#0ea5e9", arb: "#1d4ed8", op: "#ef4444",
};

function normChain(x?: string | null) {
  const s = (x ?? "").toLowerCase();
  if (s === "matic") return "pol";
  if (s === "bnb") return "bsc";
  return s;
}
function toUsd(r: ApiRow) {
  const v = r.amount_usd ?? r.amount ?? 0;
  return Math.max(0.01, Number(v) || 0.01);
}

export default function Viz3DInline() {
  const [data, setData] = useState<SceneDatum[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await fetch("/api/public/contributions/recent", { cache: "no-store" });
        if (!res.ok) throw new Error(`API ${res.status}`);
        const json = (await res.json()) as { rows: ApiRow[] };
        const rows = Array.isArray(json?.rows) ? json.rows : [];
        const mapped = rows.map((r, i) => ({
          id: r.tx || `row-${i}`,
          amountUsd: toUsd(r),
          chain: normChain(r.chain),
        }));
        if (!cancel) setData(mapped);
      } catch (e: any) {
        if (!cancel) setErr(e?.message ?? "Failed to load");
      }
    })();
    return () => { cancel = true; };
  }, []);

  return (
    <section className="mb-6">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Live 3D Contributions</h2>
        <span className="text-xs text-gray-500">Zoom & rotate, hover a block to see details</span>
      </header>

      <div className="relative h-[48vh] w-full overflow-hidden rounded-xl border border-gray-200 bg-white">
        {err && <div className="p-3 text-xs text-red-600">Failed to load: {err}</div>}
        {!err && !data && <div className="p-3 text-xs text-gray-600">Loading 3D scene…</div>}
        {!err && data && data.length === 0 && (
          <div className="p-3 text-xs text-gray-600">No contributions yet.</div>
        )}
        {!err && data && data.length > 0 && <BlocksWorld data={data} colorMap={CHAIN_COLORS} />}
      </div>
    </section>
  );
}

