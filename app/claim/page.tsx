// app/claim/page.tsx
// Claim UI – reads API JSON even on non-2xx and surfaces {ok, code, message}.
// No duplicate messages, clear mapping for common codes, and preserves user's note.
// IMPORTANT: keep the endpoint you already have (/api/claim). This page does NOT
// call per-chain ingest routes directly; it posts to the existing claim router.
//
// UX rules:
// - Show a single status box per submit
// - If API returns JSON with { ok, code, message }, always render that message
// - If JSON parse fails, fall back to "Request failed"
// - Disable button during submit
// - Keep everything in English per project rule; conversation with user stays HR

'use client';

import * as React from 'react';

type ApiResponse = {
  ok: boolean;
  code?: string;
  message?: string;
  data?: any;
};

export default function ClaimPage() {
  const [txHash, setTxHash] = React.useState('');
  const [chain, setChain] = React.useState<'eth'|'arb'|'op'|'pol'|'avax'|'bsc'|'btc'|'ltc'|'doge'|'xrp'|'xlm'|'sol'|'trx'|'dot'|'atom'>('eth');
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<null | { ok: boolean; code?: string; message: string }>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    setBusy(true);

    try {
      // POST to the existing aggregator route (do not change backend contract)
      const res = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chain, txHash: txHash.trim(), note: note.trim() || undefined }),
      });

      // Try to parse JSON regardless of res.ok
      let body: ApiResponse | null = null;
      try {
        body = (await res.json()) as ApiResponse;
      } catch {
        body = null;
      }

      if (body && typeof body.message === 'string') {
        // Normalize and show API-provided message (preferred)
        setResult({ ok: !!body.ok, code: body.code, message: body.message });
      } else {
        // Fallbacks: try to map by HTTP code when JSON missing
        const fallback = mapHttpFallback(res.status);
        setResult({ ok: false, code: fallback.code, message: fallback.message });
      }

      // On success codes that imply insertion/duplicate, optionally clear note only
      if (body?.ok && (body.code === 'inserted' || body.code === 'duplicate')) {
        setNote('');
      }
    } catch {
      // Network or CORS or unexpected crash
      setResult({
        ok: false,
        code: 'request_failed',
        message: 'Request failed. Please try again in a few moments.',
      });
    } finally {
      setBusy(false);
    }
  }

  function mapHttpFallback(status: number): { code: string; message: string } {
    if (status === 400) return { code: 'invalid_payload', message: 'Invalid payload sent to the server.' };
    if (status === 401) return { code: 'unauthorized', message: 'Unauthorized request.' };
    if (status === 404) return { code: 'tx_not_found', message: 'The hash of this transaction does not exist on the blockchain.' };
    if (status === 409) return { code: 'rpc_error', message: 'Transaction is not yet confirmed on-chain.' };
    if (status === 429) return { code: 'rate_limited', message: 'Too many requests. Please slow down.' };
    if (status >= 500) return { code: 'server_error', message: 'Server error. Please try again later.' };
    return { code: 'request_failed', message: 'Request failed. Please try again.' };
  }

  function statusTone(code?: string) {
    if (!code) return 'neutral';
    if (code === 'inserted' || code === 'duplicate') return 'success';
    if (code === 'not_project_wallet' || code === 'tx_not_found' || code === 'invalid_payload') return 'warn';
    return 'error';
  }

  const tone = statusTone(result?.code);

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Claim a contribution</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Chain</label>
          <select
            value={chain}
            onChange={(e) => setChain(e.target.value as any)}
            className="w-full rounded border px-3 py-2"
            disabled={busy}
          >
            {/* Keep only paths you have live; user said they’ll avoid calling non-existent */}
            <option value="eth">ETH</option>
            <option value="arb">ARB</option>
            <option value="op">OP</option>
            <option value="pol">POL</option>
            <option value="avax">AVAX</option>
            <option value="bsc">BSC</option>
            <option value="btc">BTC</option>
            <option value="ltc">LTC</option>
            <option value="doge">DOGE</option>
            <option value="xrp">XRP</option>
            <option value="xlm">XLM</option>
            <option value="sol">SOL</option>
            <option value="trx">TRX</option>
            <option value="dot">DOT</option>
            <option value="atom">ATOM</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Transaction hash / signature</label>
          <input
            value={txHash}
            onChange={(e) => setTxHash(e.target.value)}
            placeholder="Paste the transaction hash..."
            className="w-full rounded border px-3 py-2"
            disabled={busy}
            autoComplete="off"
          />
          <p className="text-xs text-gray-500 mt-1">
            Examples: 0x… (EVM), 64-hex (BTC/LTC/DOGE/XRP/XLM), base58 (SOL), 64-hex (TRX).
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Message (optional)</label>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Say something to the project (stored on success)…"
            className="w-full rounded border px-3 py-2"
            disabled={busy}
            maxLength={280}
          />
        </div>

        <button
          type="submit"
          disabled={busy || !txHash.trim()}
          className="rounded bg-black text-white px-4 py-2 disabled:opacity-60"
        >
          {busy ? 'Submitting…' : 'Submit claim'}
        </button>
      </form>

      {result && (
        <div
          className={[
            'mt-6 rounded border px-4 py-3',
            tone === 'success' ? 'border-green-300 bg-green-50' :
            tone === 'warn'    ? 'border-yellow-300 bg-yellow-50' :
            tone === 'error'   ? 'border-red-300 bg-red-50' :
                                 'border-gray-300 bg-gray-50',
          ].join(' ')}
        >
          <div className="text-sm">
            <strong>{result.code ?? (result.ok ? 'ok' : 'error')}</strong>
            <span className="ml-2">{result.message ?? (result.ok ? 'Done.' : 'Something went wrong.')}</span>
          </div>
        </div>
      )}
    </div>
  );
}

