'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

// Legacy public /api/claim shape (kept for backward compatibility)
type ClaimResponseOld = {
  ok: boolean;
  chain?: string;
  tx?: string;
  inserted?: unknown;
  alreadyRecorded?: boolean;
  error?: string | null;
};

// New standardized shape from claim-ingest routes
type ClaimResponseNew = {
  ok: boolean;
  code?: string;    // 'inserted' | 'duplicate' | 'not_project_wallet' | 'tx_not_found' | 'invalid_payload' | 'rpc_error' | 'unsupported_chain' | ...
  message?: string; // human-readable
  data?: any;
};

type AnyClaimResponse = ClaimResponseOld | ClaimResponseNew;
type UiMsg = { kind: 'success' | 'info' | 'error'; text: string };

// Full chain list (as requested)
const CHAINS = [
  { value: 'eth',  label: 'Ethereum (ETH)' },
  { value: 'arb',  label: 'Arbitrum (ARB)' },
  { value: 'avax', label: 'Avalanche (AVAX)' },
  { value: 'op',   label: 'Optimism (OP)' },
  { value: 'pol',  label: 'Polygon (POL)' },
  { value: 'dot',  label: 'Polkadot (DOT)' },
  { value: 'btc',  label: 'Bitcoin (BTC)' },
  { value: 'ltc',  label: 'Litecoin (LTC)' },
  { value: 'doge', label: 'Dogecoin (DOGE)' },
  { value: 'xrp',  label: 'XRP (XRP)' },
  { value: 'xlm',  label: 'Stellar (XLM)' },
  { value: 'sol',  label: 'Solana (SOL)' },
  { value: 'trx',  label: 'Tron (TRX)' },
  { value: 'bsc',  label: 'BNB Smart Chain (BSC)' },
  { value: 'atom', label: 'Cosmos (ATOM)' },
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

// Normalize & validate EVM hashes
function normalizeEvmTx(input: string) {
  const raw = input.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return ('0x' + raw).toLowerCase();
  return raw;
}
function isValidEvmHash(input: string) {
  return /^0x[0-9a-fA-F]{64}$/.test(input.trim());
}

// Hints
function expectedFormatHint(chain: string) {
  if (isEvm(chain)) return 'Expected format: 0x + 64 hex (EVM).';
  if (chain === 'sol') return 'Expected format: base58 signature (Solana).';
  return 'Expected format: chain-native transaction id/hash.';
}

// Explorers
function txExplorerUrl(chain: string, tx: string): string | null {
  switch (chain) {
    case 'eth': return `https://etherscan.io/tx/${tx}`;
    case 'op':  return `https://optimistic.etherscan.io/tx/${tx}`;
    case 'arb': return `https://arbiscan.io/tx/${tx}`;
    case 'pol': return `https://polygonscan.com/tx/${tx}`;
    case 'avax':return `https://snowtrace.io/tx/${tx}`;
    case 'bsc': return `https://bscscan.com/tx/${tx}`;
    case 'sol': return `https://solscan.io/tx/${tx}`;
    case 'btc': return `https://blockchair.com/bitcoin/transaction/${tx}`;
    case 'ltc': return `https://blockchair.com/litecoin/transaction/${tx}`;
    case 'doge':return `https://blockchair.com/dogecoin/transaction/${tx}`;
    case 'dot': return `https://polkadot.subscan.io/extrinsic/${tx}`;
    case 'atom':return `https://www.mintscan.io/cosmos/txs/${tx}`;
    case 'xrp': return `https://xrpscan.com/tx/${tx}`;
    case 'xlm': return `https://steexp.com/tx/${tx}`;
    case 'trx': return `https://tronscan.org/#/transaction/${tx}`;
    default: return null;
  }
}

/** Normalize any server response to the new {ok, code, message} contract (backward compatible). */
function normalizeResponse(resp: AnyClaimResponse): ClaimResponseNew {
  // New style
  if (Object.prototype.hasOwnProperty.call(resp, 'code') || Object.prototype.hasOwnProperty.call(resp, 'message')) {
    const r = resp as ClaimResponseNew;
    return { ok: !!r.ok, code: r.code || '', message: r.message || '', data: (r as any).data };
  }
  // Legacy mapping
  const o = resp as ClaimResponseOld;
  if (o.ok && o.alreadyRecorded) {
    return { ok: true, code: 'duplicate', message: 'The transaction has already been recorded in our project before.', data: { chain: o.chain, txHash: o.tx } };
  }
  if (o.ok && !o.alreadyRecorded) {
    return { ok: true, code: 'inserted', message: 'The transaction was successfully recorded on our project.', data: { chain: o.chain, txHash: o.tx, inserted: o.inserted } };
  }
  const err = (o.error || '').toString();
  if (err === 'tx_not_found') return { ok: false, code: 'tx_not_found', message: 'The hash of this transaction does not exist on the blockchain.', data: { chain: o.chain, txHash: o.tx } };
  if (err === 'tx_pending')   return { ok: false, code: 'rpc_error',     message: 'Transaction is not yet confirmed on-chain.', data: { chain: o.chain, txHash: o.tx } };
  if (err === 'invalid_tx_format') return { ok: false, code: 'invalid_payload', message: 'Hash format is not correct.' };
  return { ok: false, code: 'rpc_error', message: err || 'Your request could not be processed.', data: { chain: o.chain, txHash: o.tx } };
}

function classify(resp: ClaimResponseNew): UiMsg {
  const code = resp.code || '';
  if (resp.ok && code === 'inserted')  return { kind: 'success', text: 'The transaction was successfully recorded on our project.' };
  if (resp.ok && code === 'duplicate') return { kind: 'info',    text: 'The transaction has already been recorded in our project before.' };
  if (!resp.ok && code === 'not_project_wallet') return { kind: 'error', text: 'The transaction is not directed to our project. The wallet address does not belong to this project.' };
  if (!resp.ok && code === 'tx_not_found')       return { kind: 'error', text: 'The hash of this transaction does not exist on the blockchain.' };
  if (!resp.ok && code === 'invalid_payload')    return { kind: 'error', text: 'Hash format is not correct.' };
  if (!resp.ok && code === 'unsupported_chain')  return { kind: 'error', text: 'Selected chain is not yet supported.' };
  if (!resp.ok) return { kind: 'error', text: resp.message || 'Your request could not be processed.' };
  return { kind: 'info', text: resp.message || 'Processed.' };
}

function renderUserMessage(resp: ClaimResponseNew | null, chain: string, tx: string) {
  if (!resp) return null;
  const link = tx ? txExplorerUrl(chain, tx) : null;
  const ui = classify(resp);
  return (
    <div className="space-y-1">
      <div>{ui.text}</div>
      {link && <a href={link} target="_blank" rel="noreferrer" className="inline-block text-blue-600 underline">View on explorer</a>}
    </div>
  );
}

export default function ClaimPage() {
  const [chain, setChain] = useState('eth');
  const [tx, setTx] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const [resp, setResp] = useState<ClaimResponseNew | null>(null);
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
        if (window.hcaptcha && typeof window.hcaptcha.render === 'function') { resolve(); return; }
        if (document.getElementById('hcaptcha-script')) {
          const check = setInterval(() => {
            if (window.hcaptcha && typeof window.hcaptcha.render === 'function') { clearInterval(check); resolve(); }
          }, 50);
          setTimeout(() => { clearInterval(check); reject(new Error('hcaptcha_not_ready')); }, 5000);
          return;
        }
        const s = document.createElement('script');
        s.id = 'hcaptcha-script';
        s.async = true; s.defer = true;
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
          callback: (token: string) => { setHcaptchaToken(token); setCaptchaState('solved'); },
          'expired-callback': () => { setHcaptchaToken(undefined); setCaptchaState('expired'); },
          'error-callback': () => { setHcaptchaToken(undefined); setCaptchaState('error'); },
          theme:
            typeof window !== 'undefined' &&
            window.matchMedia &&
            window.matchMedia('(prefers-color-scheme: dark)').matches
              ? 'dark' : 'light',
          size: 'normal',
        });
        setCaptchaState('ready');
      })
      .catch(() => setCaptchaState('error'));
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

    const normalizedTx = isEvm(chain) ? normalizeEvmTx(tx) : tx.trim();
    if (isEvm(chain) && !isValidEvmHash(normalizedTx)) {
      const norm: ClaimResponseNew = { ok: false, code: 'invalid_payload', message: 'Hash format is not correct.' };
      setResp(norm);
      setError(norm.message || 'Invalid payload');
      setLoading(false);
      return;
    }

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
          tx: normalizedTx,
          message: msg || undefined,
          ...(hcaptchaEnabled ? { hcaptchaToken } : {}),
        }),
        cache: 'no-store',
      });

      let raw: AnyClaimResponse;
      try { raw = await r.json(); } catch { raw = { ok: false, error: 'invalid_response' } as ClaimResponseOld; }

      const norm = normalizeResponse(raw);
      setResp(norm);
      if (!norm.ok) setError(norm.message || 'Request failed.');
      resetCaptcha();
    } catch {
      setError('Network error');
      resetCaptcha();
    } finally {
      setLoading(false);
    }
  };

  const submitDisabled = loading || !tx.trim() || (hcaptchaEnabled && !hcaptchaToken);
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
          <select className="mt-1 w-full rounded-xl border px-3 py-2" value={chain} onChange={(e) => setChain(e.target.value)}>
            {CHAINS.map((c) => (<option key={c.value} value={c.value}>{c.label}</option>))}
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
          <label className="block text-sm font-medium">Message (optional)</label>
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
              <p className="mt-2 text-xs text-gray-500">Please complete the verification to enable submission.</p>
            )}
            <div className="mt-1 text-[11px] text-gray-400">Captcha: {captchaState}</div>
          </div>
        )}

        <button type="submit" disabled={submitDisabled} className="rounded-2xl bg-black px-4 py-2 text-white disabled:opacity-60">
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
          {renderUserMessage(resp, chain, isEvm(chain) ? normalizeEvmTx(tx) : tx.trim())}
        </div>
      )}
    </main>
  );
}

