// /app/about/page.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "About · BlockBattle",
  description: "What BlockBattle is, how it works, and why it is transparent by design.",
};

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-4 text-3xl font-bold tracking-tight">About BlockBattle.org</h1>
      <p className="mb-4 text-gray-700">
        BlockBattle is a transparent, year-long crypto community challenge. Each participating currency has a set of
        public addresses. Community members can voluntarily contribute funds to these addresses. We track on-chain
        totals and rank the Top 13 currencies by their USD-equivalent contributions.
      </p>

      <h2 className="mb-2 mt-8 text-xl font-semibold">Transparency</h2>
      <ul className="mb-4 list-disc pl-6 text-gray-700">
        <li>All recipient addresses are public and verifiable on-chain.</li>
        <li>Aggregations and leaderboard logic will be open and reproducible.</li>
        <li>No custody: contributions go directly to public addresses.</li>
      </ul>
    </main>
  );
}

