// app/claim/page.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

type ClaimResponse = {
  ok: boolean;
  chain?: string;
  tx?: string;
  inserted?: unknown;
  alreadyRecorded?: boolean;
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
const SHOW_DEBUG = process.env.NEXT_PUBLIC_SHOW_CAPTCHA_DEBUG === '1';

declare global {
  interface Window {
    hcaptcha?: {
      render: (
        container: HTMLElement,
        opts: {
        sitekey: string;
        callback?: (token: string) => void;
        'expired-callback'?: () => void;
        'error-callback'?: () => void;
        theme?: 'light' | 'dark';
        size?: 'normal' | 'invisible' | 'compact';
        }
      ) => number;
      reset: (widgetId?: number) => void;
      getResponse: (widgetId?: number) => string;
    };
  }
}

type CaptchaState = 'idle' | 'ready' | 'solved' | 'expired' | 'error';

export default function ClaimPage() {
  const [chain, setChain] = useState('eth');
  const [tx, setTx] = useState('');
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<ClaimResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hcaptchaEnabled = useMemo(() => !!HCAPTCHA_SITE_KEY, []);
  const [hcaptchaToken, setHcaptchaToken] = useState<string | undefined>(undefined);
  const [captchaState, setCaptchaState] = useState<CaptchaState>('idle');

  const captchaContainerRef = useRef<HTMLDivElement | null>(null);
  const captchaWidgetIdRef = useRef<number | null>(null);

  // Load & render hCaptcha explicitly (no hydration mismatch)
  useEffect(() => {
    if (!hcaptchaEnabled) return;

    function ensureScript(): Promise<void> {
      return new Promise((resolve, reject) => {
        if (window.hcaptcha && typeof window.hcaptcha.render === 'function') {
          resolve();
          return;
        }
        if (document.getElementById('hcaptcha-script')) {
          const check = setInterval(() => {
            if (window.hcaptcha && typeof window.hcaptcha.render === 'function') {
              clearInterval(check);
              resolve();
            }
          }, 50);
          setTimeout(() => {
            clearInterval(check);
            if (!(window.hcaptcha && typeof window.hcaptcha.render === 'function')) {
              reject(new Error('hcaptcha_not_ready'));
            }
          }, 5000);
          return;
        }
        const s = document.createElement('script');
        s.id = 'hcaptcha-script';
        s.async = true;
        s.defer = true;
        s.src = 'https://hcaptcha.com/1/api.js?render=explicit';
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('hcaptcha_script_failed'));
        document.head.appendChild(s);
      });
    }

    ensureScript()
      .then(() => {
        if (!captchaContainerRef.current) return;
        if (captchaWidgetIdRef.current !== null) return; // already rendered

        captchaWidgetIdRef.current = window.hcaptcha!.render(captchaContainerRef.current, {
          sitekey: HCAPTCHA_SITE_KEY,
          callback: (token: string) => {
            setHcaptchaToken(token);
            setCaptchaState('solved');
          },
          'expired-callback': () => {
            setHcaptchaToken(undefined);
            setCaptchaState('expired');
          },
          'error-callback': () => {
            // tipični slučaj: pogrešan sitekey ili domena nije dopuštena
            setHcaptchaToken(undefined);
            setCaptchaState('error');
          },
          theme:
            typeof window !== 'undefined' &&
            window.matchMedia &&
            window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark'
              : 'light',
          size: 'normal',
        });
        setCaptchaState('ready');
      })
      .catch(() => {
        setCaptchaState('error');
      });
  }, [hcaptchaEnabled]);

  const resetCaptcha = () => {
    if (hcaptchaEnabled && window.hcaptcha && captchaWidgetIdRef.current !== null) {
      window.hcaptcha.reset(captchaWidgetIdRef.current);
      setHcaptchaToken(undefined);
      setCaptchaState('ready');
    }
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
        body: JSON.stringify({
          chain,
          tx,
          ...(hcaptchaEnabled ? { hcaptchaToken } : {}),
        }),
      });
      const j = (await r.json()) as ClaimResponse;
      setResp(j);
      if (!j.ok) {
        setError(j.error ?? 'Unknown error');
        resetCaptcha();
      } else {
        resetCaptcha();
      }
    } catch {
      setError('Network error');
      resetCaptcha();
    } finally {
      setLoading(false);
    }
  };

  const submitDisabled =
    loading ||
    !tx.trim() ||
    (hcaptchaEnabled && !hcaptchaToken); // block submit until captcha solved

  const sitekeyMasked =
    HCAPTCHA_SITE_KEY ? `${HCAPTCHA_SITE_KEY.slice(0, 6)}…${HCAPTCHA_SITE_KEY.slice(-4)}` : '(empty)';

  return (
    <main className="mx-auto max-w-xl px-4 py-10">
      <h1 className="text-3xl font-bold">Claim your contribution</h1>
      <p className="mt-2 text-sm text-gray-500">
        Submit your transaction hash to attribute a public contribution.
      </p>

      {!hcaptchaEnabled && (
        <div className="mt-4 rounded-xl border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          hCaptcha is not configured. Set <code>NEXT_PUBLIC_HCAPTCHA_SITE_KEY</code> and redeploy.
        </div>
      )}

      {SHOW_DEBUG && (
        <div className="mt-3 rounded-xl border bg-gray-50 p-3 text-xs text-gray-700">
          <div><strong>DEBUG</strong></div>
          <div>host: {typeof window !== 'undefined' ? window.location.host : ''}</div>
          <div>sitekey: {sitekeyMasked}</div>
          <div>captchaState: {captchaState}</div>
          <div>token: {hcaptchaToken ? 'present' : 'none'}</div>
        </div>
      )}

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

        {hcaptchaEnabled && (
          <div>
            <label className="block text-sm font-medium">Verification</label>
            <div ref={captchaContainerRef} className="mt-2" />
            {!hcaptchaToken && (
              <>
                <p className="mt-2 text-xs text-gray-500">
                  Please complete the verification to enable submission.
                </p>
                {captchaState === 'error' && (
                  <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">
                    If you see “The sitekey for this hCaptcha is incorrect”, check:
                    <ul className="ml-4 list-disc">
                      <li><strong>Allowed Domains</strong> include <code>blockbattle.org</code> and <code>www.blockbattle.org</code> (and preview domains if used).</li>
                      <li><strong>Sitekey</strong> in env matches the same hCaptcha project as server <code>HCAPTCHA_SECRET</code>.</li>
                    </ul>
                  </div>
                )}
              </>
            )}
            <div className="mt-1 text-[11px] text-gray-400">Captcha: {captchaState}</div>
          </div>
        )}

        <button
          type="submit"
          disabled={submitDisabled}
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
          {'alreadyRecorded' in resp && <div><strong>alreadyRecorded:</strong> {String(resp.alreadyRecorded)}</div>}
          {resp.error && <div><strong>error:</strong> {resp.error}</div>}
        </div>
      )}
    </main>
  );
}

