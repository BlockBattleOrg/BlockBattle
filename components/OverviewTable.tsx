/* eslint-disable @next/next/no-img-element */
'use client';

import { useEffect, useState } from 'react';

type Row = {
  chain: string;
  height: number | null;
  status: 'ok' | 'stale' | 'issue';
  ageHours: number | null;
};

type Resp = {
  ok: boolean;
  total: number;
  ok: number;
  stale: number;
  issue: number;
  rows: Row[];
};

function badgeClasses(status: Row['status']) {
  if (status === 'ok') return 'inline-flex items-center rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-200';
  if (status === 'stale') return 'inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-200';
  return 'inline-flex items-center rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700 ring-1 ring-inset ring-rose-200';
}

function badgeDot(status: Row['status']) {
  const color = status === 'ok' ? 'bg-green-500' : status === 'stale' ? 'bg-amber-500' : 'bg-rose-500';
  return <span className={`mr-1 inline-block h-2 w-2 rounded-full ${color}`} />;
}

function logoSrc(symbol: string) {
  return `/logos/crypto/${symbol.toUpperCase()}.svg`;
}

export default function OverviewTable() {
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/public/overview', { cache: 'no-store' });
        const j = await r.json();
        if (!alive) return;
        if (!j.ok) throw new Error(j.error || 'Failed to load');
        setData(j as Resp);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || 'Failed to load');
      }
    })();
    return () => { alive = false; };
  }, []);

  return (
    <section className="mt-6">
      <h1 className="text-3xl font-semibold">BlockBattle</h1>
      <p className="mt-1 text-gray-500">Live chain heights aggregated from scheduled ingestion.</p>

      {err && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {err}
        </div>
      )}

      <div className="mt-6 overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left text-gray-600">
            <tr>
              <th className="px-4 py-3">Chain</th>
              <th className="px-4 py-3">Height</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {!data && (
              <tr>
                <td className="px-4 py-4" colSpan={4}>
                  <div className="h-4 w-32 animate-pulse rounded bg-gray-200" />
                </td>
              </tr>
            )}
            {data?.rows?.map((r) => (
              <tr key={r.chain}>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-gray-100 ring-1 ring-inset ring-gray-200">
                      <img
                        src={logoSrc(r.chain)}
                        alt={r.chain}
                        className="h-5 w-5"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                      />
                    </span>
                    <span className="font-medium">{r.chain}</span>
                  </div>
                </td>
                <td className="px-4 py-3 tabular-nums">{r.height?.toLocaleString('en-US') ?? '—'}</td>
                <td className="px-4 py-3">
                  <span className={badgeClasses(r.status)} title={r.ageHours != null ? `${r.ageHours.toFixed(2)}h old` : undefined}>
                    {badgeDot(r.status)} {r.status === 'ok' ? 'OK' : r.status === 'stale' ? 'Stale' : 'Issue'}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <a
                    className="rounded-full border px-3 py-1 text-xs text-gray-700 hover:bg-gray-50"
                    href="#participate"
                  >
                    Participate
                  </a>
                </td>
              </tr>
            ))}
            {data && data.rows.length === 0 && (
              <tr><td className="px-4 py-4 text-gray-500" colSpan={4}>No chains.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-gray-400">Source: /api/public/overview (no-store). Status: green ≤6h, yellow ≤24h, red &gt;24h.</p>
    </section>
  );
}

