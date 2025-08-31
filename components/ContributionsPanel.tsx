'use client';

import { useEffect, useState } from 'react';

type LBRow = { chain: string; total: number; contributions: number; usd_total?: number | null };
type RecentRow = { chain: string | null; amount: number | null; tx: string | null; timestamp: string | null; amount_usd?: number | null };

// koliko decimala prikazati po chainu (native units)
const DECIMALS: Record<string, number> = {
  BTC: 8, LTC: 8, DOGE: 8,
  ETH: 18, OP: 18, ARB: 18, POL: 18, AVAX: 18,
  DOT: 10, BSC: 6, ATOM: 6, XRP: 6, SOL: 9, XLM: 7, TRX: 6,
};

// normaliziraj nazive (MATIC/POLYGON → POL)
function normChain(x: string | null | undefined) {
  const s = String(x || '').toUpperCase();
  if (s === 'MATIC' || s === 'POLYGON') return 'POL';
  return s;
}

function fmtNative(amount?: number | null, chain?: string | null) {
  if (typeof amount !== 'number' || !isFinite(amount)) return '—';
  const c = normChain(chain);
  const d = DECIMALS[c] ?? 8;
  let out = amount.toLocaleString('en-US', {
    useGrouping: true,
    minimumFractionDigits: 0,
    maximumFractionDigits: d,
  });
  if (out === '0' && amount > 0) {
    out = amount.toLocaleString('en-US', {
      useGrouping: true,
      minimumFractionDigits: Math.min(6, d),
      maximumFractionDigits: d,
    });
  }
  if (out.includes('.')) out = out.replace(/(\.\d*?[1-9])0+$/,'$1').replace(/\.$/,'');
  return out;
}

function fmtUSD(n?: number | null) {
  if (typeof n !== 'number' || !isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function explorerTxUrl(chain: string | null, tx: string | null) {
  const c = normChain(chain);
  if (!tx) return '#';
  if (c === 'ETH') return `https://etherscan.io/tx/${tx}`;
  if (c === 'POL') return `https://polygonscan.com/tx/${tx}`;
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
          // back-compat ruta (re-export na novi handler)
          fetch('/api/public/contributions/leaderboard?order=usd&limit=50', { cache: 'no-store' }).then(r => r.json()),
          fetch('/api/public/contributions/recent?limit=10', { cache: 'no-store' }).then(r => r.json()),
        ]);
        if (!alive) return;
        if (!a.ok) throw new Error(a.error || 'Leaderboard error');
        if (!b.ok) throw new Error(b.error || 'Recent error');

        setLb((a.rows || []).map((r: any) => ({
          chain: normChain(r.chain),
          total: r.total,
          contributions: r.contributions,
          usd_total: r.usd_total ?? null,
        })));

        setRecent((b.rows || []).map((r: any) => ({
          chain: normChain(r.chain ?? null),
          amount: typeof r.amount === 'number' ? r.amount : null,
          tx: r.tx ?? null,
          timestamp: r.timestamp ?? null,
          amount_usd: typeof r.amount_usd === 'number' ? r.amount_usd : null,
        })));
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || 'Failed to load contributions');
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <section className="mt-12">
      <h2 className="text-xl font-semibold">Community Contributions</h2>
      <p className="text-sm text-gray-500 mb-4">
        Sentiment by chain based on contributions sent to the project wallets.
      </p>

      {err && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {/* Totals card */}
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b bg-gray-50/60 px-4 py-3">
            <div>
              <div className="text-sm font-medium">Totals by chain</div>
              <div className="text-xs text-gray-500">Native + USD (sum)</div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-left">
                  <th className="px-4 py-2 text-gray-600">Chain</th>
                  <th className="px-4 py-2 text-gray-600">Total (native)</th>
                  <th className="px-4 py-2 text-gray-600">Total (USD)</th>
                  <th className="px-4 py-2 text-gray-600">Contributions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {lb.length === 0 ? (
                  <tr><td className="px-4 py-4 text-gray-500" colSpan={4}>No contributions yet.</td></tr>
                ) : lb.map((r) => (
                  <tr key={r.chain}>
                    <td className="px-4 py-3 font-mono">{r.chain}</td>
                    <td className="px-4 py-3">{fmtNative(r.total, r.chain)}</td>
                    <td className="px-4 py-3 tabular-nums">{fmtUSD(r.usd_total ?? null)}</td>
                    <td className="px-4 py-3">{r.contributions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Recent card */}
        <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
          <div className="flex items-center justify-between border-b bg-gray-50/60 px-4 py-3">
            <div>
              <div className="text-sm font-medium">Recent contributions</div>
              <div className="text-xs text-gray-500">Latest payments (native + USD)</div>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50 text-left">
                  <th className="px-4 py-2 text-gray-600">Chain</th>
                  <th className="px-4 py-2 text-gray-600">Amount (native)</th>
                  <th className="px-4 py-2 text-gray-600">Amount (USD)</th>
                  <th className="px-4 py-2 text-gray-600">Tx</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {recent.length === 0 ? (
                  <tr><td className="px-4 py-4 text-gray-500" colSpan={4}>No recent contributions.</td></tr>
                ) : recent.map((r, i) => {
                  const url = explorerTxUrl(r.chain, r.tx);
                  const txShort = r.tx ? `${r.tx.slice(0, 10)}…${r.tx.slice(-6)}` : '—';
                  return (
                    <tr key={i}>
                      <td className="px-4 py-3 font-mono">{r.chain ?? '—'}</td>
                      <td className="px-4 py-3">{fmtNative(r.amount, r.chain)}</td>
                      <td className="px-4 py-3 tabular-nums">{fmtUSD(r.amount_usd ?? null)}</td>
                      <td className="px-4 py-3">
                        {url !== '#' ? (
                          <a className="font-mono underline decoration-dotted hover:decoration-solid" href={url} target="_blank" rel="noreferrer">
                            {txShort}
                          </a>
                        ) : <span className="font-mono">{txShort}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <p className="mt-2 text-xs text-gray-400">
        Source: /api/public/contributions/leaderboard and /api/public/contributions/recent (no-store).
      </p>
    </section>
  );
}

