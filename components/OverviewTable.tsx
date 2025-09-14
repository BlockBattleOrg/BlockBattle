// Server component version with no props,
// to match usage: <OverviewTable /> in app/page.tsx

import Image from "next/image";

type ChainRow = {
  chain: string;
  height: number | null;
  logoUrl?: string | null;
  participateUrl?: string | null;
};

type OverviewPayload = {
  ok: boolean;
  rows?: ChainRow[];
};

export default async function OverviewTable() {
  const base = process.env.NEXT_PUBLIC_BASE_URL ?? "";
  const res = await fetch(`${base}/api/public/overview`, { cache: "no-store" });
  const data = (await res.json()) as OverviewPayload;

  let rows: ChainRow[] = data.rows ?? [];
  // Hide DOT & ATOM from this table
  rows = rows.filter((r) => r.chain !== "DOT" && r.chain !== "ATOM");

  return (
    <div className="overflow-hidden rounded-xl border">
      <table className="min-w-full divide-y">
        <thead className="bg-gray-50">
          <tr className="text-left text-sm text-gray-600">
            <th className="px-4 py-3">Chain</th>
            <th className="px-4 py-3">Height</th>
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
              <td className="px-4 py-3 tabular-nums">{r.height ?? "—"}</td>
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
              <td className="px-4 py-6 text-sm text-gray-500" colSpan={3}>
                No data yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

