'use client';

import { useEffect, useState } from 'react';

type LBRow = { chain: string; total: number; contributions: number; usd_total?: number | null };
type RecentRow = { chain: string | null; amount: number; tx?: string; timestamp?: string | null; amount_usd?: number | null };

function fmtNative(n: number) {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}
function fmtUSD(n?: number | null) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
}
function short(tx?: string) {
  if (!tx) return 'n/a';
  return `${tx.slice(0, 8)}…${tx.slice(-6)}`;
}

export default function ContributionLeaderboard() {
  const [lb, setLb] = useState<LBRow[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [a, b] = await Promise.all([
          fetch('/api/public/leaderboard?order=usd&limit=50', { cache: 'no-store' }).then(r => r.json()),
          fetch('/api/public/contributions/recent?limit=10', { cache: 'no-store' }).then(r => r.json()),
        ]);
        if (!alive) return;
        if (!a.ok) throw new Error(a.error || 'Leaderboard error');
        if (!b.ok) throw new Error(b.error || 'Recent error');
        setLb(a.rows || []);
        setRecent(b.rows || []);
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
  if (err) {
    return <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">Failed to load contributions: {err}</div>;
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Totals by chain</h3>
        <div className="overflow-hidden rounded-2xl border border-gray-200">
          <table className="w-full table-auto text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 font-medium text-gray-600">Chain</th>
                <th className="px-4 py-3 font-medium text-gray-600">Total (native)</th>
                <th className="px-4 py-3 font-medium text-gray-600">Total (USD)</th>
                <th className="px-4 py-3 font-medium text-gray-600">Contributions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {lb.map((t) => (
                <tr key={t.chain}>
                  <td className="px-4 py-3 font-mono">{t.chain}</td>
                  <td className="px-4 py-3">{fmtNative(t.total)}</td>
                  <td className="px-4 py-3 tabular-nums">{fmtUSD(t.usd_total ?? null)}</td>
                  <td className="px-4 py-3">{t.contributions.toLocaleString('en-US')}</td>
                </tr>
              ))}
              {lb.length === 0 && (
                <tr><td className="px-4 py-3" colSpan={4}>No contributions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400">Totals are summed per chain in native units + USD.</p>
      </div>

      <div className="space-y-3">
        <h3 className="text-lg font-semibold">Recent contributions</h3>
        <div className="overflow-hidden rounded-2xl border border-gray-200">
          <table className="w-full table-auto text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-3 font-medium text-gray-600">Chain</th>
                <th className="px-4 py-3 font-medium text-gray-600">Amount (native)</th>
                <th className="px-4 py-3 font-medium text-gray-600">Amount (USD)</th>
                <th className="px-4 py-3 font-medium text-gray-600">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {recent.map((r, i) => (
                <tr key={i}>
                  <td className="px-4 py-3 font-mono">{r.chain ?? '—'}</td>
                  <td className="px-4 py-3">{fmtNative(r.amount)}</td>
                  <td className="px-4 py-3 tabular-nums">{fmtUSD(r.amount_usd ?? null)}</td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs text-blue-600 hover:underline">
                      {short(r.tx)}
                    </span>
                  </td>
                </tr>
              ))}
              {recent.length === 0 && (
                <tr><td className="px-4 py-3" colSpan={4}>No recent contributions.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-gray-400">Latest 10 contributions (native + USD).</p>
      </div>
    </div>
  );
}

