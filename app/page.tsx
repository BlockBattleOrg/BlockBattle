// app/page.tsx
// Force fresh SSR so the homepage always reflects latest sections.
export const revalidate = 0;
export const dynamic = "force-dynamic";

import Countdown from "@/components/Countdown";
import BlocksContainer from "@/components/BlocksContainer";

type OverviewTotals = { ok: number; stale: number; issue: number };
type OverviewRow = {
  chain: string;              // e.g. "ARB"
  height: number | null;
  status: "OK" | "STALE" | "ISSUE" | string;
  logoUrl?: string | null;
};

type OverviewPayload = {
  ok: boolean;
  totals?: OverviewTotals;
  rows?: OverviewRow[];
};

function badgeClass(s: string) {
  const v = s.toUpperCase();
  if (v === "OK") return "bg-green-100 text-green-700";
  if (v === "STALE") return "bg-yellow-100 text-yellow-700";
  if (v === "ISSUE") return "bg-red-100 text-red-700";
  return "bg-gray-100 text-gray-700";
}

// Simple mapping for Participate CTA anchors per chain (adjust as needed).
function participateHref(chain: string) {
  // Example anchors on /about page:
  // #donate-arb, #donate-eth, #donate-bsc ...
  return `/about#donate-${chain.toLowerCase()}`;
}

async function fetchOverview(): Promise<OverviewPayload> {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "";
  const res = await fetch(`${base}/api/public/overview`, { cache: "no-store" });
  if (!res.ok) {
    return { ok: false, totals: { ok: 0, stale: 0, issue: 0 }, rows: [] };
  }
  return (await res.json()) as OverviewPayload;
}

export default async function HomePage() {
  const campaignEnd = process.env.NEXT_PUBLIC_CAMPAIGN_END ?? "";
  const overview = await fetchOverview();
  const totals = overview.totals ?? { ok: 0, stale: 0, issue: 0 };
  const rows = overview.rows ?? [];

  return (
    <main className="mx-auto max-w-6xl p-6">
      {/* ===== Hero with countdown ===== */}
      <section className="mb-8">
        <h1 className="text-3xl font-bold">BlockBattle</h1>
        <p className="mt-1 max-w-2xl text-sm text-gray-600">
          A transparent, year-long community challenge. More contributions → more blocks → stronger community signal.
        </p>

        <div className="mt-4">
          <Countdown
            endIso={campaignEnd}
            label="Time remaining in this year-long challenge"
          />
        </div>
      </section>

      {/* ===== Live Community Blocks (auto-refresh + chain filter) ===== */}
      <section className="space-y-3 mb-10">
        <h2 className="text-xl font-semibold">Live Community Blocks</h2>
        <p className="text-sm text-gray-600">
          Each square represents a contribution. Bigger amount → bigger block. More contributions → more blocks.
        </p>
        <BlocksContainer limit={200} refreshMs={60000} />
      </section>

      {/* ===== Existing Overview (cards + table with Participate) ===== */}
      <section className="space-y-6">
        <header>
          <h2 className="text-xl font-semibold">BlockBattle</h2>
          <p className="text-sm text-gray-600">
            Live chain heights aggregated from scheduled ingestion.
          </p>
        </header>

        {/* Summary cards */}
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">OK</div>
            <div className="mt-1 text-3xl font-bold tabular-nums">{totals.ok}</div>
          </div>
          <div className="rounded-xl border p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">STALE</div>
            <div className="mt-1 text-3xl font-bold tabular-nums">{totals.stale}</div>
          </div>
          <div className="rounded-xl border p-4">
            <div className="text-xs font-medium uppercase tracking-wide text-gray-500">ISSUE</div>
            <div className="mt-1 text-3xl font-bold tabular-nums">{totals.issue}</div>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-hidden rounded-xl border">
          <table className="min-w-full divide-y">
            <thead className="bg-gray-50">
              <tr className="text-left text-sm text-gray-600">
                <th className="px-4 py-3">Chain</th>
                <th className="px-4 py-3">Height</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y bg-white">
              {rows.map((r) => (
                <tr key={r.chain} className="text-sm">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {/* If you have logo URLs in API, render them; otherwise simple dot */}
                      {r.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          alt={r.chain}
                          src={r.logoUrl}
                          width={18}
                          height={18}
                          className="rounded-sm"
                        />
                      ) : (
                        <span className="inline-block h-4 w-4 rounded-sm bg-gray-300" />
                      )}
                      <span className="font-medium">{r.chain}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{r.height ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${badgeClass(
                        r.status
                      )}`}
                    >
                      {r.status.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <a
                      href={participateHref(r.chain)}
                      className="rounded-full border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Participate
                    </a>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td className="px-4 py-6 text-sm text-gray-500" colSpan={4}>
                    No data yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

