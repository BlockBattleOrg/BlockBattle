// app/page.tsx
export const revalidate = 0;
export const dynamic = "force-dynamic";

import Countdown from "@/components/Countdown";
import BlocksContainer from "@/components/BlocksContainer";

export default async function HomePage() {
  const campaignEnd = process.env.NEXT_PUBLIC_CAMPAIGN_END ?? "";

  return (
    <main className="mx-auto max-w-6xl p-6">
      {/* Hero */}
      <section className="mb-8">
        <h1 className="text-3xl font-bold">BlockBattle</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">
          A transparent, year-long community challenge. More contributions → more blocks → stronger community signal.
        </p>

        <div className="mt-4">
          <Countdown
            endIso={campaignEnd}
            label="Time remaining in this year-long challenge"
            // Optionally: startIso={process.env.NEXT_PUBLIC_CAMPAIGN_START}
          />
        </div>
      </section>

      {/* Live blocks */}
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Live Community Blocks</h2>
        <p className="text-sm text-gray-600">
          Each square represents a contribution. Bigger amount → bigger block. More contributions → more blocks.
        </p>

        <BlocksContainer limit={200} refreshMs={60000} />
      </section>
    </main>
  );
}

