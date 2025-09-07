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

const EVM_CHAINS = ['eth', 'op', 'arb', 'pol', 'avax', 'bsc'] as const;
const isEvm = (c: string) => (EVM_CHAINS as unknown as string[]).includes(c);

// Normalize EVM tx hashes: allow 64-hex without 0x; emit 0x + lowercase
function normalizeEvmTx(input: string) {
  const raw = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return ('0x' + raw).toLowerCase();
  return raw;
}

// Expected format hint per chain
function expectedFormatHint(chain: string) {
  if (isEvm(chain)) return 'Expected format: 0x + 64 hex (EVM).';
  if (chain === 'sol') return 'Expected format: base58 signature (Solana).';
  return 'Expected format: chain-native transaction id/hash.';
}

// Explorer URL per chain
function txExplorerUrl(chain: string, tx: string): string | null {
  switch (chain) {
    case 'eth': return `https://etherscan.io/tx/${tx}`;
    case 'op': return `https://optimistic.etherscan.io/tx/${tx}`;
    case 'arb': return `https://arbiscan.io/tx/${tx}`;
    case 'pol': return `https://polygonscan.com/tx/${tx}`;
    case 'avax': return `https://snowtrace.io/tx/${tx}`;
    case 'bsc': return `https://bscscan.com/tx/${tx}`;
    case 'sol': return `https://solscan.io/tx/${tx}`;
    case 'btc': return `https://blockchair.com/bitcoin/transaction/${tx}`;
    case 'ltc': return `https://blockchair.com/litecoin/transaction/${tx}`;
    case 'doge': return `https://blockchair.com/dogecoin/transaction/${tx}`;
    case 'dot': return `https://polkadot.subscan.io/extrinsic/${tx}`;
    case 'atom': return `https://www.mintscan.io/cosmos/txs/${tx}`;
    case 'xrp': return `https://xrpscan.com/tx/${tx}`;
    case 'xlm': return `https://steexp.com/tx/${tx}`;
    case 'trx': return `https://tronscan.org/#/transaction/${tx}`;
    default: return null;
  }
}

function renderUserMessage(resp: ClaimResponse | null) {
  if (!resp) return null;
  const link = resp.chain && resp.tx ? txExplorerUrl(resp.chain, resp.tx) : null;

  if (resp.ok && resp.alreadyRecorded) {
    return (
      <div className="space-y-1">
        <div>Your transaction is already recorded in our database ✅</div>
        {link && <a href={link} target="_blank" rel="noreferrer" className="inline-block text-blue-600 underline">View on explorer</a>}
      </div>
    );
  }
  if (resp.ok && !resp.alreadyRecorded) {
    return (
      <div className="space-y-1">
        <div>Your transaction has been successfully recorded ✅</div>
        {link && <a href={link} target="_blank" rel="noreferrer" className="inline-block text-blue-600 underline">View on explorer</a>}
      </div>
    );
  }

  const e = (resp.error || '').toString();
  if (e === 'tx_not_found') {
    return <div>We could not find this transaction on the selected chain yet. If it was just submitted, please try again in a few minutes.</div>;
  }
  if (e === 'tx_pending') {
    return <div>This transaction is not confirmed on the selected chain yet. Please try again later once it has enough confirmations.</div>;
  }
  return <div>Error: {resp.error}</div>;
}

export default function ClaimPage() {
  const [chain, setChain] = useState('eth');
  const [tx, setTx] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState<ClaimResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hcaptchaEnabled = useMemo(() => !!HCAPTCHA_SITE_KEY, []);
  const [hcaptchaToken, setHcaptchaToken] = useState<string | undefined>(undefined);
  const [captchaState, setCaptchaState] = useState<CaptchaState>('idle');

  const captchaContainerRef = useRef<HTMLDivElement | null>(null);
  const captchaWidgetIdRef = useRef<number | null>(null);

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
            reject(new Error('hcaptcha_not_ready'));
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
        if (captchaWidgetIdRef.current !== null) return;

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

    const txToSend = isEvm(chain) ? normalizeEvmTx(tx) : tx.trim();
    const msg = message.trim();
    if (msg.length > 280) {
      setError('Message is too long (max 280 characters).');
      setLoading(false);
      return;
    }

    try {
      const r = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chain,
          tx: txToSend,
          message: msg || undefined,
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
    (hcaptchaEnabled && !hcaptchaToken);

  const msgLen = message.trim().length;

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
          <p className="mt-1 text-xs text-gray-500">{expectedFormatHint(chain)}</p>
        </div>

        <div>
          <label className="block text-sm font-medium">
            Message (optional)
          </label>
          <textarea
            className="mt-1 w-full rounded-xl border px-3 py-2"
            rows={3}
            maxLength={280}
            placeholder="Say something about your contribution (max 280 chars)…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="mt-1 text-xs text-gray-500">{msgLen}/280</div>
        </div>

        {hcaptchaEnabled && (
          <div>
            <label className="block text-sm font-medium">Verification</label>
            <div ref={captchaContainerRef} className="mt-2" />
            {!hcaptchaToken && (
              <p className="mt-2 text-xs text-gray-500">
                Please complete the verification to enable submission.
              </p>
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
          {renderUserMessage(resp)}
        </div>
      )}
    </main>
  );
}

