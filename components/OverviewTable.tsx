'use client';

import React from 'react';
import ParticipateModal from './ParticipateModal';

type Status = 'ok' | 'stale' | 'issue';

type Row = {
  symbol: string;           // display symbol
  height: number | null;
  status: Status;
  logoUrl: string | null;
};

type Resp = {
  ok: boolean;
  total: number;
  okCount: number;
  staleCount: number;
  issueCount: number;
  rows: Row[];
  error?: string;
};

type Wallet = {
  chain: string;
  address: string;
  memo_tag?: string | null;
  explorer_template?: string | null;
  uri_scheme?: string | null;
};

export default function OverviewTable() {
  const [data, setData] = React.useState<Resp | null>(null);
  const [loading, setLoading] = React.useState<boolean>(true);
  const [err, setErr] = React.useState<string | null>(null);

  // Modal state
  const [modalOpen, setModalOpen] = React.useState(false);
  const [wallet, setWallet] = React.useState<Wallet | null>(null);
  const [walletError, setWalletError] = React.useState<string | null>(null);
  const [walletLoading, setWalletLoading] = React.useState(false);

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
            setErr(json.error ?? 'Unknown error');
            setData(null);
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
    return () => { cancelled = true; };
  }, []);

  const openModal = async (symbol: string) => {
    setModalOpen(true);
    setWallet(null);
    setWalletError(null);
    setWalletLoading(true);
    try {
      // API endpoint koji vraća wallet za simbol
      const res = await fetch(`/api/public/wallets?symbol=${encodeURIComponent(symbol)}`, {
        cache: 'no-store',
      });
      const json = await res.json();
      if (json.ok) {
        setWallet(json.wallet as Wallet);
      } else {
        setWalletError(json.error ?? 'Wallet not found');
      }
    } catch (e: any) {
      setWalletError(String(e?.message || e));
    } finally {
      setWalletLoading(false);
    }
  };

  const badge = (s: Status) =>
    s === 'ok'
      ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700'
      : s === 'stale'
      ? 'rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700'
      : 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700';

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
    <>
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
                <th className="px-4 py-2 font-medium text-gray-600">Chain</th>
                <th className="px-4 py-2 font-medium text-gray-600">Height</th>
                <th className="px-4 py-2 font-medium text-gray-600">Status</th>
                <th className="px-4 py-2 font-medium text-gray-600">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.symbol} className="border-t">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      {r.logoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={r.logoUrl}
                          alt=""
                          className="h-5 w-5"
                          loading="lazy"
                          aria-hidden="true"
                        />
                      ) : null}
                      <span className="font-medium">{r.symbol}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 tabular-nums">{r.height ?? '—'}</td>
                  <td className="px-4 py-2">
                    <span className={badge(r.status)}>{r.status.toUpperCase()}</span>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => openModal(r.symbol)}
                      className="rounded-full border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Participate
                    </button>
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
      </div>

      <ParticipateModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        wallet={wallet}
        loading={walletLoading}
        error={walletError}
      />
    </>
  );
}

