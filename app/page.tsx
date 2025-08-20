// app/page.tsx
import Countdown from "@/components/Countdown";
import Leaderboard from "@/components/Leaderboard";
import TreemapPlaceholder from "@/components/TreemapPlaceholder";
import Ticker from "@/components/Ticker";
import { MOCK_LEADERBOARD, MOCK_TICKER } from "@/data/mock";

export default function HomePage() {
  // Challenge ends: Dec 31, 2025 23:59:59 UTC (example; real date will be set via env/DB)
  const endsAt = "2025-12-31T23:59:59Z";

  return (
    <main className="mx-auto max-w-6xl px-4">
      {/* Hero */}
      <section className="py-12">
        <div className="grid items-center gap-8 md:grid-cols-2">
          <div>
            <h1 className="mb-3 text-4xl font-bold tracking-tight">
              A year-long, transparent crypto community challenge.
            </h1>
            <p className="mb-6 text-gray-600">
              Contribute to public addresses for your favorite currency and climb the leaderboard. All data is open.
            </p>
            <div className="flex items-center gap-4">
              <a className="rounded-xl bg-black px-5 py-3 text-white hover:opacity-90" href="#leaderboard">
                Participate
              </a>
              <Countdown endsAt={endsAt} />
            </div>
          </div>
          <TreemapPlaceholder />
        </div>
      </section>

      <Ticker messages={MOCK_TICKER} />

      {/* Leaderboard */}
      <section id="leaderboard" className="py-10">
        <div className="mb-4 flex items-end justify-between">
          <h2 className="text-2xl font-semibold tracking-tight">Top 15 Ranking</h2>
          <p className="text-sm text-gray-500">Mock data — live data in Phase 3</p>
        </div>
        <Leaderboard rows={MOCK_LEADERBOARD} />
      </section>
    </main>
  );
}

