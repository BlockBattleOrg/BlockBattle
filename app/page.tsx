// app/page.tsx
import OverviewTable from '@/components/OverviewTable';

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
    </main>
  );
}

