// components/OverviewTable.tsx
'use client';

import { useEffect, useState } from 'react';

type OverviewRow = { chain: string; height: number | null };
type OverviewResp = {
  ok: boolean;
  total: number;
  updated: number;
  rows: OverviewRow[];
  error?: string;
};

export default function OverviewTable() {
  const [data, setData] = useState<OverviewResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/public/overview', { cache: 'no-store' });
        const json = (await res.json()) as OverviewResp;
        if (!alive) return;
        if (!res.ok || !json.ok) {
          setErr(json.error || `HTTP ${res.status}`);
        } else {
          setData(json);
        }
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || 'Unexpected error');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="w-full rounded-xl border border-gray-200 p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-6 w-52 rounded bg-gray-200" />
          <div className="h-4 w-full rounded bg-gray-200" />
          <div className="h-4 w-full rounded bg-gray-200" />
          <div className="h-4 w-2/3 rounded bg-gray-200" />
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        <strong>Failed to load data:</strong> {err}
      </div>
    );
  }

  if (!data || !data.rows?.length) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        No data available yet.
      </div>
    );
  }

  const fmt = (n: number | null) =>
    n == null ? 'n/a' : n.toLocaleString('en-US');

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-xl font-semibold">Chain Heights (live)</h2>
          <p className="text-sm text-gray-500">
            Updated chains: {data.updated}/{data.total}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-gray-200">
        <table className="w-full table-auto text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-3 font-medium text-gray-600">Chain</th>
              <th className="px-4 py-3 font-medium text-gray-600">Height</th>
              <th className="px-4 py-3 font-medium text-gray-600">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.rows.map((r) => {
              const ok = r.height != null;
              return (
                <tr key={r.chain}>
                  <td className="px-4 py-3 font-mono">{r.chain}</td>
                  <td className="px-4 py-3">{fmt(r.height)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        'inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs ' +
                        (ok
                          ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                          : 'bg-gray-50 text-gray-600 ring-1 ring-gray-200')
                      }
                    >
                      <span
                        className={
                          'h-1.5 w-1.5 rounded-full ' +
                          (ok ? 'bg-emerald-500' : 'bg-gray-400')
                        }
                      />
                      {ok ? 'OK' : 'N/A'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-gray-400">
        Source: /api/public/overview (cached ~30s at the edge).
      </p>
    </div>
  );
}

