// app/claim/page.tsx
// Original claim UI with hCaptcha and original message input box size

'use client';

import * as React from 'react';
import HCaptcha from '@hcaptcha/react-hcaptcha';

export default function ClaimPage() {
  const [chain, setChain] = React.useState('eth');
  const [txHash, setTxHash] = React.useState('');
  const [note, setNote] = React.useState('');
  const [captchaToken, setCaptchaToken] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<any>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);

    try {
      const res = await fetch('/api/claim', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chain,
          txHash: txHash.trim(),
          note: note.trim() || undefined,
          captcha: captchaToken,
        }),
      });
      const data = await res.json().catch(() => null);
      setResult(data || { ok: false, code: 'request_failed', message: 'Request failed.' });
      if (data?.ok && (data.code === 'inserted' || data.code === 'duplicate')) {
        setNote('');
        setTxHash('');
      }
    } catch {
      setResult({ ok: false, code: 'request_failed', message: 'Request failed.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl p-6">
      <h1 className="text-2xl font-semibold mb-4">Claim a contribution</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Chain</label>
          <select
            value={chain}
            onChange={(e) => setChain(e.target.value)}
            className="w-full rounded border px-3 py-2"
            disabled={busy}
          >
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
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Message (optional)</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Say something to the project (stored on success)…"
            className="w-full rounded border px-3 py-2"
            disabled={busy}
            rows={3}
            maxLength={280}
          />
        </div>

        <div>
          <HCaptcha
            sitekey={process.env.NEXT_PUBLIC_HCAPTCHA_SITE_KEY!}
            onVerify={(token) => setCaptchaToken(token)}
          />
        </div>

        <button
          type="submit"
          disabled={busy || !txHash.trim() || !captchaToken}
          className="rounded bg-black text-white px-4 py-2 disabled:opacity-60"
        >
          {busy ? 'Submitting…' : 'Submit claim'}
        </button>
      </form>

      {result && (
        <div
          className={[
            'mt-6 rounded border px-4 py-3',
            result.ok
              ? 'border-green-300 bg-green-50'
              : 'border-red-300 bg-red-50',
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

