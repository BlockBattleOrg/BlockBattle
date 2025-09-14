'use client';

import React from 'react';
import ParticipateModal from './ParticipateModal';

// ↓ Maknuli smo Status i sve vezano uz njega

type Row = {
  symbol: string;           // BTC, MATIC, BNB…
  height: number | null;
  logoUrl: string | null;   // /logos/crypto/BTC.svg
};

type Resp = {
  ok: boolean;
  total: number;
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
  TRX: 'tron',
  LTC: 'litecoin',
  XLM: 'stellar',
  OP: 'op',
  ARB: 'arb',
  AVAX: 'avax',
  BNB: 'bsc',
  // DOT/ATOM uklonjeni
};

// mapiranje za /claim (očekuje npr. eth, arb, pol, avax, op, bsc, btc, itd.)
const SYMBOL_TO_CLAIM: Record<string, string> = {
  BTC: 'btc',
  ETH: 'eth',
  SOL: 'sol',
  XRP: 'xrp',
  DOGE: 'doge',
  MATIC: 'pol',
  TRX: 'trx',
  LTC: 'ltc',
  XLM: 'xlm',
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

  // Participate (CTA)
  const openParticipate = async (symbol: string) => {
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

  // Claim (popup s /claim i preselektiranim chain paramom)
  const openClaim = (symbol: string) => {
    const claimChain = SYMBOL_TO_CLAIM[symbol];
    const url = claimChain ? `/claim?chain=${encodeURIComponent(claimChain)}` : '/claim';
    window.open(
      url,
      'claim',
      'width=860,height=900,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes'
    );
  };

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
        {/* Maknuli smo OK/STALE/ISSUE brojače iznad tablice */}

        <div className="overflow-x-auto rounded-2xl border">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-2 font-medium text-gray-600">Chain</th>
                <th className="px-4 py-2 font-medium text-gray-600">Height</th>
                <th className="px-4 py-2 font-medium text-gray-600">Participate</th>
                <th className="px-4 py-2 font-medium text-gray-600">Claim</th>
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
                    <button
                      onClick={() => openParticipate(r.symbol)}
                      className="rounded-full border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Participate
                    </button>
                  </td>
                  <td className="px-4 py-2">
                    <button
                      onClick={() => openClaim(r.symbol)}
                      className="rounded-full border px-3 py-1 text-xs hover:bg-gray-50"
                    >
                      Claim
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

      {/* Modal za Participate */}
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

