import TreemapBattle from "@/components/treemap/TreemapBattle";

export const dynamic = "force-dynamic";

export default function TreemapPreviewPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Treemap Preview</h1>
        <p className="text-sm text-gray-600">
          Daily rollup from <code>aggregates_daily</code>. Not linked in the main navigation.
        </p>
      </header>

      <TreemapBattle period="all" limit={5} />
    </main>
  );
}

