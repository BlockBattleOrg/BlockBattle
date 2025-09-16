"use client";

// components/treemap/TreemapSection.tsx
// Small wrapper section rendered below "Totals by chain".
// Shows Treemap Top 5 (All-time). English-only.

import TreemapBattle from "@/components/treemap/TreemapBattle";

export default function TreemapSection() {
  return (
    <section className="mt-10">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Treemap Top 5 (All-time)</h2>
        <span className="text-xs text-gray-500">
          Hover for details • Colors match Community Blocks
        </span>
      </header>

      <div className="rounded-xl border border-gray-200 bg-white p-3">
        {/* Smaller height so the section doesn’t dominate the page */}
        <TreemapBattle period="all" limit={5} height={260} />
      </div>
      <div className="mt-1 text-right text-[11px] text-gray-400">Data refreshes daily</div>
    </section>
  );
}

