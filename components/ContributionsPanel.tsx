// components/ContributionsPanel.tsx
'use client';

import { useEffect, useState } from 'react';

type LBRow = { chain: string; total: number; contributions: number };
type RecentRow = { chain: string; amount: number; tx: string; timestamp: string };

function explorerTxUrl(chain: string, tx: string) {
  const c = chain.toUpperCase();
  if (c === 'ETH') return `https://etherscan.io/tx/${tx}`;
  if (c === 'POL' || c === 'MATIC' || c === 'POLYGON') return `https://polygonscan.com/tx/${tx}`;
  // add more as we onboard (BTC, LTC… with native explorers)
  return '#';
}

export default function ContributionsPanel() {
  const [lb, setLb] = useState<LBRow[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [a, b] = await Promise.all([
          fetch('/api/public/contributions/leaderboard', { cache: 'no-store' }).then((r) => r.json()),
          fetch('/api/public/contributions/recent', { cache: 'no-store' }).then((r) => r.json()),
        ]);
        if (!alive) return;
        if (!a.ok) throw new Error(a.error || 'Leaderboard error');
        if (!b.ok) throw new Error(b.error || 'Recent error');
        setLb(a.rows || []);
        setRecent(b.rows || []);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || 'Failed to load contributions');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="mt-8">
      <h3 className="text-lg font-semibold">Community Contributions</h3>
      <p className="text-sm text-gray-500">
        Sentiment by chain based on contributions sent to the project wallets.
      </p>

      {err && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">{err}</div>
      )}

      <div className="mt-4 grid gap-4 md:grid-cols-2">
        {/* Leaderboard */}
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
              {lb.length === 0 ? (
                <tr>
                  <td className="px-4 py-3 text-gray-500" colSpan={3}>
                    No contributions yet.
                  </td>
                </tr>
              ) : (
                lb.map((r) => (
                  <tr key={r.chain}>
                    <td className="px-4 py-3 font-mono">{r.chain}</td>
                    <td className="px-4 py-3">{r.total.toLocaleString('en-US')}</td>
                    <td className="px-4 py-3">{r.contributions}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Recent */}
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
              {recent.length === 0 ? (
                <tr>
                  <td className="px-4 py-3 text-gray-500" colSpan={3}>
                    No recent contributions.
                  </td>
                </tr>
              ) : (
                recent.map((r, i) => {
                  const url = explorerTxUrl(r.chain, r.tx);
                  const short = `${r.tx.slice(0, 10)}…${r.tx.slice(-6)}`;
                  return (
                    <tr key={i}>
                      <td className="px-4 py-3 font-mono">{r.chain}</td>
                      <td className="px-4 py-3">{r.amount.toLocaleString('en-US')}</td>
                      <td className="px-4 py-3">
                        {url === '#' ? (
                          <span className="font-mono">{short}</span>
                        ) : (
                          <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono underline decoration-dotted hover:decoration-solid"
                          >
                            {short}
                          </a>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

