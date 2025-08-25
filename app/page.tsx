// app/page.tsx
import OverviewTable from '@/components/OverviewTable';
import ContributionLeaderboard from '@/components/ContributionLeaderboard';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-bold">BlockBattle</h1>
        <p className="text-sm text-gray-500">
          Live chain heights aggregated from scheduled ingestion.
        </p>
      </header>

      <OverviewTable />

      <section className="mt-12">
        <h2 className="mb-3 text-xl font-semibold">Community Contributions</h2>
        <p className="mb-4 text-sm text-gray-500">
          Sentiment by chain based on contributions sent to the project wallets.
        </p>
        <ContributionLeaderboard />
      </section>
    </main>
  );
}

