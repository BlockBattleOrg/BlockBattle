// This component is now aligned with OverviewSection: no status counters/column.
// If you keep using this table elsewhere, it renders only Chain, Height, Action.

type Status = "ok" | "stale" | "issue" | string;

type Row = {
  chain: string;
  height: number | null;
  status?: Status;              // kept optional for future use
  participateUrl?: string | null;
};

type Props = {
  rows: Row[];
};

export default function OverviewTable({ rows }: Props) {
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
                <span className="font-medium">{r.chain}</span>
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

