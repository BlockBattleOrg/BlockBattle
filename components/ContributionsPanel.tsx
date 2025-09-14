'use client';

import { useEffect, useState } from 'react';

type LBRow = { chain: string; total: number; contributions: number; usd_total?: number | null };
type RecentRow = {
  chain: string | null;
  amount: number | null;
  tx: string | null;
  timestamp: string | null;
  amount_usd?: number | null;
  note?: string | null;          // ⬅ NEW
};

const DECIMALS: Record<string, number> = {
  BTC: 8, LTC: 8, DOGE: 8,
  ETH: 18, OP: 18, ARB: 18, POL: 18, AVAX: 18,
  DOT: 10,
  BSC: 6, BNB: 6,                 // ⬅ BNB alias (prikaz)
  ATOM: 6, XRP: 6, SOL: 9, XLM: 7, TRX: 6,
};

function normChain(x: string | null | undefined) {
  const s = String(x || '').toUpperCase();
  if (s === 'MATIC' || s === 'POLYGON') return 'POL';
  if (s === 'BNB') return 'BSC';         // ⬅ BNB → BSC
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

function explorerTxUrl(chain: string | null | undefined, tx: string | null | undefined) {
  if (!tx) return '#';
  const c0 = String(chain || '').toUpperCase();
  const c = normChain(c0);

  // EVM family
  if (c === 'ETH') return `https://etherscan.io/tx/${tx}`;
  if (c === 'BSC') return `https://bscscan.com/tx/${tx}`;            // ⬅ radi i kad je izvorno BNB
  if (c === 'ARB') return `https://arbiscan.io/tx/${tx}`;
  if (c === 'OP')  return `https://optimistic.etherscan.io/tx/${tx}`;
  if (c === 'POL') return `https://polygonscan.com/tx/${tx}`;
  if (c === 'AVAX') return `https://snowtrace.io/tx/${tx}`;
  if (c === 'TRX')  return `https://tronscan.org/#/transaction/${tx}`;

  // UTXO / others
  if (c === 'BTC')  return `https://mempool.space/tx/${tx}`;
  if (c === 'LTC')  return `https://blockchair.com/litecoin/transaction/${tx}`;
  if (c === 'DOGE') return `https://blockchair.com/dogecoin/transaction/${tx}`;

  // Cosmos / others
  if (c === 'ATOM') return `https://www.mintscan.io/cosmos/txs/${tx}`;
  if (c === 'DOT')  return `https://polkadot.subscan.io/extrinsic/${tx}`;
  if (c === 'XRP')  return `https://xrpscan.com/tx/${tx}`;
  if (c === 'XLM')  return `https://stellar.expert/explorer/public/tx/${tx}`;
  if (c === 'SOL')  return `https://solscan.io/tx/${tx}`;

  return '#';
}

function RowSkeleton({ cols }: { cols: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-4 py-3">
          <div className="h-4 w-24 animate-pulse rounded bg-gray-200" />
        </td>
      ))}
    </tr>
  );
}

function trimNote(s?: string | null) {
  const v = (s || '').trim();
  if (!v) return '—';
  return v.length > 160 ? v.slice(0, 160) + '…' : v;
}

export default function ContributionsPanel() {
  const [lb, setLb] = useState<LBRow[] | null>(null);
  const [recent, setRecent] = useState<RecentRow[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [a, b] = await Promise.all([
          fetch('/api/public/contributions/leaderboard?order=usd&limit=50', { cache: 'no-store' }).then(r => r.json()),
          // ⬇ recent endpoint sada treba vraćati i "note" (vidi točku 2)
          fetch('/api/public/contributions/recent?limit=10', { cache: 'no-store' }).then(r => r.json()),
        ]);
        if (!alive) return;
        if (!a.ok) throw new Error(a.error || 'Leaderboard error');
        if (!b.ok) throw new Error(b.error || 'Recent error');

        setLb(a.rows as LBRow[]);
        setRecent(b.rows as RecentRow[]);
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
      <p className="mb-4 text-sm text-gray-500">
        Sentiment by chain based on contributions sent to the project wallets.
      </p>

      {err && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      {/* Recent FIRST (kako si tražio) */}
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b bg-gray-50/60 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <div className="text-sm font-medium">Recent contributions</div>
            <span className="text-xs text-gray-500">(updated hourly)</span>
          </div>
          <div className="text-xs text-gray-500">Latest payments (native + USD)</div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b bg-gray-50 text-left">
                <th className="px-4 py-2 text-gray-600">Chain</th>
                <th className="px-4 py-2 text-gray-600">Amount (native)</th>
                <th className="px-4 py-2 text-gray-600">Amount (USD)</th>
                <th className="px-4 py-2 text-gray-600">Note</th> {/* ⬅ NEW */}
                <th className="px-4 py-2 text-gray-600">Tx</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {!recent && <RowSkeleton cols={5} />}
              {recent && recent.length === 0 && (
                <tr><td className="px-4 py-4 text-gray-500" colSpan={5}>No recent contributions.</td></tr>
              )}
              {recent?.map((r, i) => {
                const url = explorerTxUrl(r.chain, r.tx);
                const txShort = r.tx ? `${r.tx.slice(0, 10)}…${r.tx.slice(-6)}` : '—';
                return (
                  <tr key={`${r.tx ?? 'row'}-${i}`}>
                    <td className="px-4 py-3 font-mono">{normChain(r.chain) || '—'}</td>
                    <td className="px-4 py-3">{fmtNative(r.amount, r.chain)}</td>
                    <td className="px-4 py-3 tabular-nums">{fmtUSD(r.amount_usd ?? null)}</td>
                    <td className="px-4 py-3">
                      <span title={(r.note || '').trim()}>{trimNote(r.note)}</span>
                    </td>
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

      {/* Totals BELOW (kako si tražio) */}
      <div className="mt-4 overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <div className="flex items-center justify-between border-b bg-gray-50/60 px-4 py-3">
          <div className="flex items-baseline gap-2">
            <div className="text-sm font-medium">Totals by chain</div>
            <span className="text-xs text-gray-500">(updated hourly)</span>
          </div>
          <div className="text-xs text-gray-500">Native + USD (sum)</div>
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
              {!lb && <RowSkeleton cols={4} />}
              {lb && lb.length === 0 && (
                <tr><td className="px-4 py-4 text-gray-500" colSpan={4}>No contributions yet.</td></tr>
              )}
              {lb?.map((r) => (
                <tr key={r.chain}>
                  <td className="px-4 py-3 font-mono">{normChain(r.chain)}</td>
                  <td className="px-4 py-3">{fmtNative(r.total, r.chain)}</td>
                  <td className="px-4 py-3 tabular-nums">{fmtUSD(r.usd_total ?? null)}</td>
                  <td className="px-4 py-3">{r.contributions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p className="mt-2 text-xs text-gray-400">
        Source: /api/public/contributions/leaderboard and /api/public/contributions/recent (no-store).
      </p>
    </section>
  );
}

