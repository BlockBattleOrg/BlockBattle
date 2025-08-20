// components/Leaderboard.tsx
type Row = {
  rank: number;
  symbol: string;
  name: string;
  totalUsd: number;
  txCount: number;
};

function formatUSD(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

export default function Leaderboard({ rows }: { rows: Row[] }) {
  return (
    <div className="overflow-hidden rounded-2xl border">
      <table className="min-w-full divide-y">
        <thead className="bg-gray-50">
          <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
            <th className="px-4 py-3">Rank</th>
            <th className="px-4 py-3">Logo</th>
            <th className="px-4 py-3">Currency</th>
            <th className="px-4 py-3">Total (USD)</th>
            <th className="px-4 py-3">Tx count</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((r) => (
            <tr key={r.rank} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium tabular-nums">{r.rank}</td>
              <td className="px-4 py-3">
                <div className="h-6 w-6 rounded bg-gray-200" aria-label={`${r.symbol} logo`} />
              </td>
              <td className="px-4 py-3">{r.name} <span className="text-xs text-gray-500">({r.symbol})</span></td>
              <td className="px-4 py-3 font-medium tabular-nums">{formatUSD(r.totalUsd)}</td>
              <td className="px-4 py-3 tabular-nums">{r.txCount}</td>
              <td className="px-4 py-3">
                <button className="rounded-xl border px-3 py-1 text-sm hover:bg-gray-50">Participate</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

