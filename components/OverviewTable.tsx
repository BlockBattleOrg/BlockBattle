'use client';

import React from 'react';
import ParticipateModal from './ParticipateModal';

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
  DOT: 'polkadot',
  ATOM: 'cosmos',
  TRX: 'tron',
  LTC: 'litecoin',
  XLM: 'stellar',
  OP: 'op',
  ARB: 'arb',
  AVAX: 'avax',
  BNB: 'bsc',
  // ADA: 'cardano', // po potrebi
};

// Pokušaj izvući wallet iz različitih oblika odgovora
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

  // 1) { ok:true, wallet:{...} }
  if (json.wallet) {
    const w = normalize(json.wallet);
    if (w) return w;
  }

  // 2) { ok:true, address:"...", chain:"..." }
  if (json.address || json.chain) {
    const w = normalize(json);
    if (w) return w;
  }

  // 3) { ok:true, data:{...} } ili { ok:true, result:{...} }
  if (json.data) {
    const w = normalize(json.data);
    if (w) return w;
  }
  if (json.result) {
    // ponekad je result array
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

  // 4) { ok:true, wallets:[...] }
  if (Array.isArray(json.wallets)) {
    // prvo aktivni ako postoji
    const active = json.wallets.find((w: any) => w?.is_active === true) ?? json.wallets[0];
    const w = normalize(active);
    if (w) return w;
  }

  // 5) { ok:true } ali u drugom polju
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

  // Modal state – ono što ParticipateModal očekuje
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

  // Klik na Participate -> fetch walleta i predaj modalu
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

      // Pomogni si u konzoli
      // eslint-disable-next-line no-console
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

  const badge = (s: Status) =>
    s === 'ok'
      ? 'rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700'
      : s === 'stale'
      ? 'rounded-full bg-yellow-100 px-2 py-0.5 text-xs font-medium text-yellow-700'
      : 'rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700';

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
                        <img src={r.logoUrl} alt="" className="h-5 w-5" loading="lazy" aria-hidden="true" />
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

      {/* Modal očekuje {open, onClose, wallet, loading, error} */}
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

