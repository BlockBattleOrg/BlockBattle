"use client";

// components/treemap/TreemapSection.tsx
// Lightweight section za umetanje ispod "Totals by chain".
// Prikazuje Treemap Top 5 (ALL-TIME) uz naslov i kratki opis.

import TreemapBattle from "@/components/treemap/TreemapBattle";

export default function TreemapSection() {
  return (
    <section className="mt-10">
      <header className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-semibold">Treemap Top 5 (All-time)</h2>
        <span className="text-xs text-gray-500">Hover za detalje • boje usklađene s Community Blocks</span>
      </header>

      {/* Visina je prilagođena da stane ispod tablica bez skrola */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <TreemapBattle period="all" limit={5} />
      </div>
    </section>
  );
}

