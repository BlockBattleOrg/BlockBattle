// components/OverviewSection.tsx
import Image from "next/image";

type ChainRow = {
  chain: string;        // e.g. 'ARB'
  height: number | null;
  status: "OK" | "STALE" | "ISSUE" | string;
  logoUrl?: string | null;
  participateUrl?: string | null; // optional CTA
};

type OverviewPayload = {
  ok: boolean;
  totals?: { ok: number; stale: number; issue: number };
  rows?: ChainRow[];
  // you can extend with latency, updatedAt, etc. when API adds it
};

function badgeClass(s: string) {
  const v = s.toUpperCase();
  if (v === "OK") return "bg-green-100 text-green-700";
  if (v === "STALE") return "bg-yellow-100 text-yellow-700";
  if (v === "ISSUE") return "bg-red-100 text-red-700";
  return "bg-gray-100 text-gray-700";
}

// Server component: fetch on the server (no client JS needed)
export default async function OverviewSection() {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "";
  const res = await fetch(`${base}/api/public/overview`, { cache: "no-store" });
  const data = (await res.json()) as OverviewPayload;

  const totals = data.totals ?? { ok: 0, stale: 0, issue: 0 };
  const rows: ChainRow[] = data.rows ?? [];

  return (
    <section className="mt-10 space-y-6">
      <header>
        <h2 className="text-xl font-semibold">Chain Overview</h2>
        <p className="text-sm text-gray-600">
          Live chain heights aggregated from scheduled ingestion.
        </p>
      </header>

      {/* Totals */}
      <div className="grid gap-4 sm:grid-cols-3">
        <CardStat label="OK" value={totals.ok} />
        <CardStat label="STALE" value={totals.stale} />
        <CardStat label="ISSUE" value={totals.issue} />
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
                    {r.logoUrl ? (
                      <Image
                        src={r.logoUrl}
                        alt={r.chain}
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
                <td className="px-4 py-3 tabular-nums">
                  {r.height ?? "—"}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs ${badgeClass(r.status)}`}>
                    {r.status.toUpperCase()}
                  </span>
                </td>
                <td className="px-4 py-3">
                  {r.participateUrl ? (
                    <a
                      href={r.participateUrl}
                      className="rounded-full border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Participate
                    </a>
                  ) : (
                    <span className="text-xs text-gray-400">—</span>
                  )}
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
  );
}

function CardStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </div>
      <div className="mt-1 text-3xl font-bold tabular-nums">{value}</div>
    </div>
  );
}

