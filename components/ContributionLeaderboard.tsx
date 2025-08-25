// components/ContributionLeaderboard.tsx
'use client';

import { useEffect, useState } from 'react';

type Tot = { chain: string; total: number; contribution_count: number };
type Recent = { chain: string; amount: number; txid?: string; timestamp?: string | null };
type Resp = { ok: boolean; totals: Tot[]; recent: Recent[]; error?: string };

function fmt(n: number) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

export default function ContributionLeaderboard() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/public/leaderboard', { cache: 'no-store' });
        const json = (await res.json()) as Resp;
        if (!alive) return;
        if (!res.ok || !json.ok) setErr(json.error || `HTTP ${res.status}`);
        else setData(json);
      } catch (e: any) {
        if (alive) setErr(e?.message || 'Unexpected error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  if (loading) {
    return <div className="rounded-xl border border-gray-200 p-4 text-sm text-gray-500">Loading contributions…</div>;
  }
  if (err || !data) {
    return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">Failed to load contributions: {err || 'Unknown error'}</div>;
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Leaderboard by Total Contributions</h3>
        <div className="overflow-hidden rounded-2xl border border-gray-200">
          <table className="w-full table-auto text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 font-medium text-gray-600">Chain</th>
                <th className="px-4 py-3 font-medium text-gray-600">Total (native)</th>
                <th className="px-4 py-3 font-medium text-gray-600">Contributions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.totals.map((t) => (
                <tr key={t.chain}>
                  <td className="px-4 py-3 font-mono">{t.chain}</td>
                  <td className="px-4 py-3">{fmt(t.total)}</td>
                  <td className="px-4 py-3">{t.contribution_count.toLocaleString('en-US')}</td>
                </tr>
              ))}
              {data.totals.length === 0 && (
                <tr><td className="px-4 py-3" colSpan={3}>No contributions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400">Totals are summed in native units per chain.</p>
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Most Recent Contributions</h3>
        <div className="overflow-hidden rounded-2xl border border-gray-200">
          <table className="w-full table-auto text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 font-medium text-gray-600">Chain</th>
                <th className="px-4 py-3 font-medium text-gray-600">Amount</th>
                <th className="px-4 py-3 font-medium text-gray-600">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.recent.map((r, i) => (
                <tr key={i}>
                  <td className="px-4 py-3 font-mono">{r.chain}</td>
                  <td className="px-4 py-3">{fmt(r.amount)}</td>
                  <td className="px-4 py-3">
                    {r.txid ? (
                      <span className="font-mono text-xs text-blue-600 hover:underline">
                        {r.txid.slice(0, 8)}…{r.txid.slice(-6)}
                      </span>
                    ) : (
                      <span className="text-gray-400">n/a</span>
                    )}
                  </td>
                </tr>
              ))}
              {data.recent.length === 0 && (
                <tr><td className="px-4 py-3" colSpan={3}>No recent contributions.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400">Latest 20 contributions (native units).</p>
      </div>
    </div>
  );
}

