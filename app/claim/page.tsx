// app/claim/page.tsx
'use client';

import { useMemo, useState } from 'react';

type ClaimResponse = {
  ok: boolean;
  chain?: string;
  tx?: string;
  inserted?: unknown;
  error?: string | null;
};

const CHAINS = [
  { value: 'eth', label: 'Ethereum (ETH)' },
  { value: 'op', label: 'Optimism (OP)' },
  { value: 'arb', label: 'Arbitrum (ARB)' },
  { value: 'pol', label: 'Polygon (POL)' },
  { value: 'avax', label: 'Avalanche (AVAX)' },
  { value: 'bsc', label: 'BNB Smart Chain (BSC)' },
  { value: 'btc', label: 'Bitcoin (BTC)' },
  { value: 'ltc', label: 'Litecoin (LTC)' },
  { value: 'doge', label: 'Dogecoin (DOGE)' },
  { value: 'dot', label: 'Polkadot (DOT)' },
  { value: 'atom', label: 'Cosmos (ATOM)' },
  { value: 'xrp', label: 'XRP (XRP)' },
  { value: 'sol', label: 'Solana (SOL)' },
  { value: 'xlm', label: 'Stellar (XLM)' },
  { value: 'trx', label: 'Tron (TRX)' },
];

const HCAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY || '';

export default function ClaimPage() {
  const [chain, setChain] = useState('eth');
  const [tx, setTx] = useState('');
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<ClaimResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hcaptchaEnabled = useMemo(() => !!HCAPTCHA_SITE_KEY, []);
  const [hcaptchaToken, setHcaptchaToken] = useState<string | undefined>(undefined);

  if (hcaptchaEnabled && typeof window !== 'undefined' && !document.getElementById('hcaptcha-script')) {
    const s = document.createElement('script');
    s.id = 'hcaptcha-script';
    s.async = true;
    s.defer = true;
    s.src = 'https://hcaptcha.com/1/api.js?render=explicit';
    document.head.appendChild(s);
  }

  const renderHCaptcha = () => {
    if (!hcaptchaEnabled) return null;
    return (
      <div className="mt-3" id="hcaptcha-container">
        <div
          className="h-captcha"
          data-sitekey={HCAPTCHA_SITE_KEY}
          data-callback={(token: string) => setHcaptchaToken(token)}
        />
      </div>
    );
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setResp(null);
    setLoading(true);

    try {
      const r = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chain, tx, ...(hcaptchaEnabled ? { hcaptchaToken } : {}) }),
      });
      const j = (await r.json()) as ClaimResponse;
      setResp(j);
      if (!j.ok) setError(j.error ?? 'Unknown error');
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-3xl font-bold">Claim your contribution</h1>
      <p className="mt-2 text-sm text-gray-500">
        Submit your transaction hash to attribute a public contribution.
      </p>

      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <div>
          <label className="block text-sm font-medium">Chain</label>
          <select
            className="mt-1 w-full rounded-xl border px-3 py-2"
            value={chain}
            onChange={(e) => setChain(e.target.value)}
          >
            {CHAINS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium">Transaction hash</label>
          <input
            className="mt-1 w-full rounded-xl border px-3 py-2"
            placeholder="0x… | hex | base58 (SOL)"
            value={tx}
            onChange={(e) => setTx(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>

        {renderHCaptcha()}

        <button
          type="submit"
          disabled={loading}
          className="rounded-2xl bg-black px-4 py-2 text-white disabled:opacity-60"
        >
          {loading ? 'Submitting…' : 'Submit'}
        </button>
      </form>

      {error && (
        <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          Error: {error}
        </div>
      )}

      {resp && (
        <div className="mt-4 rounded-xl border bg-gray-50 p-3 text-sm">
          <div><strong>ok:</strong> {String(resp.ok)}</div>
          {resp.chain && <div><strong>chain:</strong> {resp.chain}</div>}
          {resp.tx && <div><strong>tx:</strong> {resp.tx}</div>}
          {'inserted' in resp && <div><strong>inserted:</strong> {JSON.stringify(resp.inserted)}</div>}
          {resp.error && <div><strong>error:</strong> {resp.error}</div>}
        </div>
      )}
    </main>
  );
}

