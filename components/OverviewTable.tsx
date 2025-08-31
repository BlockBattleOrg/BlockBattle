'use client';

import React from 'react';

type Status = 'ok' | 'stale' | 'issue';

type Row = {
  symbol: string;
  height: number | null;
  updatedAt: string | null;
  status: Status;
};

type Resp = {
  ok: boolean;        // API status flag
  total: number;      // ukupno redaka u "rows"
  okCount: number;    // broj OK chainova
  staleCount: number; // broj STALE chainova
  issueCount: number; // broj ISSUE chainova
  rows: Row[];
  error?: string;
};

export default function OverviewTable() {
  const [data, setData] = React.useState<Resp | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [err, setErr] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const res = await fetch('/api/public/overview', { cache: 'no-store' });
        const json = (await res.json()) as Resp;
        if (!cancelled) {
          if (json.ok) {
            setData(json);
            setErr(null);
          } else {
            setData(null);
            setErr(json.error ?? 'Unknown error');
          }
        }
      } catch (e: any) {
        if (!cancelled) {
          setErr(String(e?.message || e));
          setData(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="w-full rounded-2xl border border-gray-200 p-6">
        <div className="text-sm text-gray-500">Loading overview…</div>
      </div>
    );
  }

  if (err) {
    return (
      <div className="w-full rounded-2xl border border-red-200 bg-red-50 p-6">
        <div className="font-medium text-red-700">Overview error</div>
        <div className="text-sm text-red-600">{err}</div>
      </div>
    );
  }

  const rows = data?.rows ?? [];

  return (
    <div className="w-full space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-2xl border p-4">
          <div className="text-xs text-gray-500">OK</div>
          <div className="text-2xl font-semibold">{data?.okCount ?? 0}</div>
        </div>
        <div className="rounded-2xl border p-4">
          <div className="text-xs text-gray-500">STALE</div>
          <div className="text-2xl font-semibold">{data?.staleCount ?? 0}</div>
        </div>
        <div className="rounded-2xl border p-4">
          <div className="text-xs text-gray-500">ISSUE</div>
          <div className="text-2xl font-semibold">{data?.issueCount ?? 0}</div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-2 font-medium text-gray-600">Symbol</th>
              <th className="px-4 py-2 font-medium text-gray-600">Height</th>
              <th className="px-4 py-2 font-medium text-gray-600">Updated</th>
              <th className="px-4 py-2 font-medium text-gray-600">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className="border-t">
                <td className="px-4 py-2 font-medium">{r.symbol}</td>
                <td className="px-4 py-2 tabular-nums">{r.height ?? '—'}</td>
                <td className="px-4 py-2">
                  {r.updatedAt ? new Date(r.updatedAt).toLocaleString() : '—'}
                </td>
                <td className="px-4 py-2">
                  <span
                    className={
                      r.status === 'ok'
                        ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700'
                        : r.status === 'stale'
                        ? 'rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700'
                        : 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700'
                    }
                  >
                    {r.status.toUpperCase()}
                  </span>
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-gray-500">
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-gray-500">
        Total: {data?.total ?? 0}
      </div>
    </div>
  );
}

