"use client";

// components/treemap/TreemapSection.tsx
// Wrapper sekcija ispod "Totals by chain".
// Prikazuje Treemap Top 5 (All-time). English-only labels.

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
        {/* TreemapBattle sada sam upravlja visinom (h-[24vh]) */}
        <TreemapBattle period="all" limit={5} />
      </div>
      <div className="mt-1 text-right text-[11px] text-gray-400">Data refreshes daily</div>
    </section>
  );
}

