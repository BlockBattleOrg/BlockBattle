'use client';

import React from 'react';
import ParticipateModal from './ParticipateModal';

// Status tip može ostati, ali ga ne renderiramo
type Status = 'ok' | 'stale' | 'issue';

type Row = {
  symbol: string;           // BTC, MATIC, BNB…
  height: number | null;
  status: Status;
  logoUrl: string | null;   // /logos/crypto/BTC.svg
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

/** currencies.symbol -> wallets.chain (lowercase iz tablice wallets) */
const SYMBOL_TO_CHAIN: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'eth',
  SOL: 'solana',
  XRP: 'xrp',
  DOGE: 'dogecoin',
  MATIC: 'pol',
  // DOT i ATOM maknuti iz UI; mapiranje može ostati ili ih možeš obrisati:
  // DOT: 'polkadot',
  // ATOM: 'cosmos',
  TRX: 'tron',
  LTC: 'litecoin',
  XLM: 'stellar',
  OP: 'op',
  ARB: 'arb',
  AVAX: 'avax',
  BNB: 'bsc',
};

function coerceWallet(json: any, fallbackChain: string): Wallet | null {
  if (!json) return null;

  const normalize = (w: any): Wallet | null => {
    if (!w) return null;
    const address = w.address ?? w.addr ?? null;
    const chain = w.chain ?? fallbackChain;
    if (!address) return null;
    return {
      chain: String(chain),
      address: String(address),
      memo_tag: w.memo_tag ?? w.tag ?? null,
      explorer_template: w.explorer_template ?? w.explorer ?? null,
      uri_scheme: w.uri_scheme ?? w.scheme ?? null,
    };
  };

  if (json.wallet) {
    const w = normalize(json.wallet);
    if (w) return w;
  }
  if (json.address || json.chain) {
    const w = normalize(json);
    if (w) return w;
  }
  if (json.data) {
    const w = normalize(json.data);
    if (w) return w;
  }
  if (json.result) {
    if (Array.isArray(json.result)) {
      for (const it of json.result) {
        const w = normalize(it);
        if (w) return w;
      }
    } else {
      const w = normalize(json.result);
      if (w) return w;
    }
  }
  if (Array.isArray(json.wallets)) {
    const active = json.wallets.find((w: any) => w?.is_active === true) ?? json.wallets[0];
    const w = normalize(active);
    if (w) return w;
  }
  for (const key of ['payload', 'value']) {
    if (json[key]) {
      const w = normalize(json[key]);
      if (w) return w;
    }
  }
  return null;
}

export default function OverviewTable() {
  const [data, setData] = React.useState<Resp | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [err, setErr] = React.useState<string | null>(null);

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
          if (json.ok) { setData(json); setErr(null); }
          else { setData(null); setErr(json.error ?? 'Unknown error'); }
        }
      } catch (e: any) {
        if (!cancelled) { setData(null); setErr(String(e?.message || e)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const openModal = async (symbol: string) => {
    const chainParam = SYMBOL_TO_CHAIN[symbol] ?? symbol.toLowerCase();

    setModalOpen(true);
    setWallet(null);
    setWalletError(null);
    setWalletLoading(true);

    try {
      const res = await fetch(`/api/public/wallets?chain=${encodeURIComponent(chainParam)}`, {
        cache: 'no-store',
      });
      const json = await res.json();
      console.debug('[wallet api response]', chainParam, json);

      if (json?.ok === false) {
        setWalletError(json?.error ?? 'No wallet configured for this chain yet.');
      } else {
        const coerced = coerceWallet(json, chainParam);
        if (coerced) {
          setWallet(coerced);
          setWalletError(null);
        } else {
          setWalletError(json?.error ?? 'No wallet configured for this chain yet.');
        }
      }
    } catch (e: any) {
      setWalletError(String(e?.message || e));
    } finally {
      setWalletLoading(false);
    }
  };

  if (loading) {
    return <div className="w-full rounded-2xl border border-gray-200 p-6"><div className="text-sm text-gray-500">Loading overview…</div></div>;
  }
  if (err) {
    return (
      <div className="w-full rounded-2xl border border-red-200 bg-red-50 p-6">
        <div className="font-medium text-red-700">Overview error</div>
        <div className="text-sm text-red-600">{err}</div>
      </div>
    );
  }

  const rows = (data?.rows ?? [])
    // po želji možeš filtrirati DOT/ATOM ako ih backend još šalje
    .filter(r => r.symbol !== 'DOT' && r.symbol !== 'ATOM');

  return (
    <>
      {/* Brojači (OK/STALE/ISSUE) maknuti */}

      <div className="overflow-x-auto rounded-2xl border">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-2 font-medium text-gray-600">Chain</th>
              <th className="px-4 py-2 font-medium text-gray-600">Height</th>
              {/* Status kolona maknuta */}
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
                      <img src={r.logoUrl} alt="" className="h-5 w-5" loading="lazy" aria-hidden="true" />
                    ) : null}
                    <span className="font-medium">{r.symbol}</span>
                  </div>
                </td>
                <td className="px-4 py-2 tabular-nums">{r.height ?? '—'}</td>
                {/* Status celija maknuta */}
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
                <td colSpan={3} className="px-4 py-8 text-center text-gray-500">
                  No rows.
                </td>
              </tr>
            )}
          </tbody>
        </table>
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

