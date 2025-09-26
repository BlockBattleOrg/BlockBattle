// /app/page.tsx
import OverviewTable from '@/components/OverviewTable';
import ContributionsPanel from '@/components/ContributionsPanel';
import Countdown from '@/components/Countdown';
import BlocksContainer from '@/components/BlocksContainer';
import Viz3DInline from '@/components/three/Viz3DInline'; // ⬅ 3D viz Community Blocks
import TreemapSection from '@/components/treemap/TreemapSection'; // ⬅ Top 5 (All-time)
import Script from 'next/script';

export default function HomePage() {
  const campaignEnd = process.env.NEXT_PUBLIC_CAMPAIGN_END ?? '';

  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      {/* Hero + Countdown */}
      <header className="mb-8">
        <h1 className="text-2xl font-bold">BlockBattle</h1>

        {/* Intro copy (motivational, user-facing) */}
        <p className="mt-2 max-w-3xl text-sm text-gray-600">
          Welcome to a space where true crypto communities reveal their strength. This challenge brings
          together <strong>13 leading blockchain projects</strong> – all listed on major global exchanges
          with proven reputations. The mission is simple: to show the <strong>real support</strong> behind
          each chain, free from pump-and-dump cycles, fake news, or media hype.
        </p>
        <p className="mt-2 max-w-3xl text-sm text-gray-600">
          Every contribution reflects genuine <strong>commitment and sacrifice</strong> from the community.
          At the end of this journey, you’ll see clear statistics and visual insights –
          <strong> authentic indicators</strong> of which blockchains truly stand tall.
        </p>

        <div className="mt-4">
          {/* Configure NEXT_PUBLIC_CAMPAIGN_END on Vercel (ISO, e.g. 2026-01-01T00:00:00Z) */}
          <Countdown endIso={campaignEnd} label="Time remaining in this challenge" />
        </div>
      </header>

      {/* JSON-LD structured data */}
      <Script
        id="ld-organization"
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'Organization',
            name: 'BlockBattle',
            url: 'https://www.blockbattle.org/',
            logo: 'https://www.blockbattle.org/logo_blockbattle.png',
            sameAs: [
              'https://x.com/BlockBattleOrg' // TODO: replace if your X handle differs
            ]
          })
        }}
      />
      <Script
        id="ld-website"
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            '@context': 'https://schema.org',
            '@type': 'WebSite',
            name: 'BlockBattle',
            url: 'https://www.blockbattle.org/'
            // You can add a SearchAction later if on-site search is implemented
          })
        }}
      />

      {/* Inline 3D viz Community Blocks */}
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

      {/* ⬇ Treemap — Top 5 (All-time), below Totals by chain */}
      <TreemapSection />
    </main>
  );
}

