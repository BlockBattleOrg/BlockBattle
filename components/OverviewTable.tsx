// components/OverviewTable.tsx
'use client';

import { useEffect, useMemo, useState } from 'react';
import ParticipateModal from '@/components/ParticipateModal';

type OverviewRow = { chain: string; height: number | null; ok?: boolean | null };
type OverviewResp = { ok: boolean; total: number; updated: number; rows: OverviewRow[]; error?: string };

type Wallet = { chain: string; address: string; note?: string | null };

function classNames(...xs: Array<string | false | null | undefined>) {
  return xs.filter(Boolean).join(' ');
}

function norm(symbol: string) {
  const s = String(symbol || '').toUpperCase();
  if (s === 'MATIC' || s === 'POLYGON') return 'POL';
  return s;
}

function fmtHeight(h?: number | null) {
  if (typeof h !== 'number' || !isFinite(h)) return '—';
  return h.toLocaleString('en-US');
}

// Chain + logo s avatar pozadinom
function ChainWithLogo({ chain }: { chain: string }) {
  const c = norm(chain);
  const [ok, setOk] = useState(true);
  return (
    <div className="flex items-center gap-2">
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gray-100">
        {ok && (
          <img
            src={`/logos/crypto/${c}.svg`}
            alt={`${c} logo`}
            className="h-4 w-4"
            onError={() => setOk(false)}
          />
        )}
      </div>
      <span className="font-mono">{c}</span>
    </div>
  );
}

export default function OverviewTable() {
  const [data, setData] = useState<OverviewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletErr, setWalletErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoading(true);
        setErr(null);
        const res = await fetch('/api/public/overview', { cache: 'no-store' });
        const json: OverviewResp = await res.json();
        if (!res.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${res.status}`);
        if (!alive) return;
        setData(json.rows || []);
      } catch (e: any) {
        if (!alive) return;
        setErr(e?.message || 'Failed to load data');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const rows = useMemo(() => (Array.isArray(data) ? data : []), [data]);

  async function onParticipateClick(chain: string) {
    try {
      setWallet(null);
      setWalletErr(null);
      setWalletLoading(true);
      setOpen(true);

      const res = await fetch(`/api/public/wallet?chain=${encodeURIComponent(chain)}`, { cache: 'no-store' });
      if (res.ok) {
        const j = await res.json();
        const w: Wallet | null =
          (j?.wallet && j?.wallet?.address) ? { chain, address: j.wallet.address, note: j.wallet.note ?? null } : null;
        setWallet(w);
      } else {
        setWallet(null);
      }
    } catch (e: any) {
      setWalletErr(e?.message || 'Unable to load wallet');
      setWallet(null);
    } finally {
      setWalletLoading(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white p-4 text-sm text-gray-500">
        Loading chain heights…
      </div>
    );
  }
  if (err) {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load: {err}
      </div>
    );
  }

  return (
    <>
      <div className="overflow-hidden rounded-2xl border border-gray-200 bg-white">
        <table className="w-full table-auto text-sm">
          <thead className="bg-gray-50/80 text-left">
            <tr>
              <th className="px-4 py-3 font-medium text-gray-600">Chain</th>
              <th className="px-4 py-3 font-medium text-gray-600">Height</th>
              <th className="px-4 py-3 font-medium text-gray-600">Status</th>
              <th className="px-4 py-3 font-medium text-gray-600">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r) => {
              const chain = norm(r.chain);
              const statusOk = r.ok ?? true;
              return (
                <tr key={chain}>
                  <td className="px-4 py-3">
                    <ChainWithLogo chain={chain} />
                  </td>
                  <td className="px-4 py-3 tabular-nums">{fmtHeight(r.height)}</td>
                  <td className="px-4 py-3">
                    <span
                      className={classNames(
                        'inline-flex items-center gap-2 rounded-full px-2 py-1 text-xs',
                        statusOk
                          ? 'bg-green-50 text-green-700 ring-1 ring-inset ring-green-200'
                          : 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200'
                      )}
                    >
                      <span
                        className={classNames(
                          'h-2 w-2 rounded-full',
                          statusOk ? 'bg-green-500' : 'bg-red-500'
                        )}
                      />
                      {statusOk ? 'OK' : 'Issue'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => onParticipateClick(chain)}
                      className="rounded-full border border-gray-300 bg-white px-3 py-1 text-xs font-medium text-gray-800 shadow-sm hover:bg-gray-50"
                    >
                      Participate
                    </button>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td className="px-4 py-6 text-gray-500" colSpan={4}>
                  No data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ParticipateModal
        open={open}
        onClose={() => setOpen(false)}
        wallet={wallet}
        loading={walletLoading}
        error={walletErr}
      />
    </>
  );
}

