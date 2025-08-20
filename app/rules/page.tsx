// app/rules/page.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Rules · BlockBattle",
  description: "Participation rules for the BlockBattle challenge.",
};

export default function RulesPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-4 text-3xl font-bold tracking-tight">Rules</h1>
      <ol className="list-decimal pl-6 text-gray-700">
        <li className="mb-3">
          <strong>Voluntary contributions.</strong> Sending funds to the published addresses is fully voluntary and not a purchase.
        </li>
        <li className="mb-3">
          <strong>No refunds.</strong> All transfers are on-chain and irreversible. Double‑check addresses and networks.
        </li>
        <li className="mb-3">
          <strong>Fair play.</strong> Sybil or wash‑like activity to game rankings may be filtered from aggregates.
        </li>
        <li className="mb-3">
          <strong>Transparency.</strong> Addresses, aggregation approach and update frequency will be public.
        </li>
        <li className="mb-3">
          <strong>No promises of profit.</strong> This is a community challenge and ranking showcase, not financial advice.
        </li>
        <li className="mb-3">
          <strong>Compliance.</strong> Participants are responsible for following their local laws and tax rules.
        </li>
      </ol>
      <p className="mt-8 text-sm text-gray-500">These rules may evolve to protect fairness and transparency.</p>
    </main>
  );
}

