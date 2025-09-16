// app/page.tsx
import OverviewTable from '@/components/OverviewTable';
import ContributionsPanel from '@/components/ContributionsPanel';
import Countdown from '@/components/Countdown';
import BlocksContainer from '@/components/BlocksContainer';
import Viz3DInline from '@/components/three/Viz3DInline'; // ⬅ 3D viz iznad Community Blocks
import TreemapSection from '@/components/treemap/TreemapSection'; // ⬅ NOVO: sekcija s Top 5 (All-time)

export default function HomePage() {
  const campaignEnd = process.env.NEXT_PUBLIC_CAMPAIGN_END ?? '';

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      {/* Hero + Countdown */}
      <header className="mb-8">
        <h1 className="text-2xl font-bold">BlockBattle</h1>
        <p className="text-sm text-gray-500">
          Live chain heights aggregated from scheduled ingestion.
        </p>

        <div className="mt-4">
          {/* Configure NEXT_PUBLIC_CAMPAIGN_END on Vercel (ISO, e.g. 2026-01-01T00:00:00Z) */}
          <Countdown endIso={campaignEnd} label="Time remaining in this year-long challenge" />
        </div>
      </header>

      {/* Inline 3D viz iznad Community Blocks */}
      <Viz3DInline />

      {/* Live Community Blocks (auto-refresh + chain filter) */}
      <section className="mb-10 space-y-3">
        <h2 className="text-xl font-semibold">Community Blocks</h2>
        <p className="text-sm text-gray-600">
          Each square represents a contribution. Bigger amount → bigger block. More contributions → more blocks.
        </p>
        <BlocksContainer limit={200} refreshMs={60000} />
      </section>

      {/* Status overview */}
      <OverviewTable />

      {/* Community contributions (leaderboard + recent) */}
      <ContributionsPanel />

      {/* ⬇ Treemap — Top 5 (All-time), odmah ispod Totals by chain */}
      <TreemapSection />
    </main>
  );
}

