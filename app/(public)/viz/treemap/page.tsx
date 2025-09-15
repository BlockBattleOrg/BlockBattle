// app/(public)/viz/treemap/page.tsx
// Preview page for the Top 15 Treemap (daily rollup)
// This page is not linked in the main nav — use /viz/treemap to review the chart.

import TreemapBattle from "@/components/treemap/TreemapBattle";

export const dynamic = "force-dynamic"; // ensure fresh fetch from /api/public/treemap

export default function TreemapPreviewPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Treemap Preview</h1>
        <p className="text-sm text-gray-600">
          Daily rollup from <code>aggregates_daily</code>. Not linked in the main navigation.
        </p>
      </header>

      {/* 30d by default; change to "7d" | "ytd" if you want */}
      <TreemapBattle period="30d" />
    </main>
  );
}

