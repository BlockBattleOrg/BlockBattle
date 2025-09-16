import BlocksContainer from "@/components/BlocksContainer";
import ContributionsPanel from "@/components/ContributionsPanel"; // ⬅ dodano: prikazuje Recent + Totals by chain
import TreemapSection from "@/components/treemap/TreemapSection"; // ⬅ dodano: Treemap Top 5 (All-time)

export default async function BlocksPage() {
  return (
    <main className="mx-auto max-w-6xl p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold">Community Blocks</h1>
        <p className="text-sm text-gray-600">
          Each square represents a contribution. Bigger amount → bigger block. More contributions → more blocks.
        </p>
      </header>

      {/* Client-side container handles fetching, filtering, and auto-refresh */}
      <BlocksContainer limit={200} refreshMs={60000} />

      {/* Community contributions (leaderboard + recent) */}
      <ContributionsPanel />

      {/* Treemap — Top 5 (All-time), odmah ispod Totals by chain */}
      <TreemapSection />
    </main>
  );
}

