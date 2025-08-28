/* eslint-disable @next/next/no-img-element */
'use client';

import { useEffect, useMemo, useState } from 'react';

type Wallet = {
  chain: string;
  address: string;
  memo_tag?: string | null;
  explorer_template?: string | null;
  uri_scheme?: string | null;
};

function buildExplorerUrl(tpl: string | null | undefined, address: string) {
  if (!tpl) return null;
  return tpl.includes('{address}') ? tpl.replace('{address}', address) : tpl;
}

// Very lightweight URI mapping; we keep raw addresses for EVM by default.
function buildQrText(w: Wallet): string {
  const c = w.chain.toUpperCase();
  const a = w.address;
  switch (c) {
    case 'BTC': return `bitcoin:${a}`;
    case 'LTC': return `litecoin:${a}`;
    case 'DOGE': return `dogecoin:${a}`;
    // EVM-like: raw address is fine for MVP
    case 'ETH':
    case 'OP':
    case 'ARB':
    case 'POL':
    case 'AVAX':
      return a;
    case 'XRP':
    case 'XLM':
    case 'TRX':
    case 'SOL':
    case 'DOT':
    case 'BSC':
    case 'ATOM':
      return a;
    default:
      return a;
  }
}

export default function ParticipateModal({
  open,
  onClose,
  wallet,
  loading = false,
  error = null,
}: {
  open: boolean;
  onClose: () => void;
  wallet: Wallet | null;
  loading?: boolean;           // <-- NEW
  error?: string | null;       // <-- NEW
}) {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  const qrText = useMemo(() => (wallet ? buildQrText(wallet) : ''), [wallet]);
  const explorerUrl = wallet ? buildExplorerUrl(wallet.explorer_template, wallet.address) : null;

  useEffect(() => {
    let alive = true;
    async function gen() {
      if (!open || !wallet) return setQrDataUrl(null);
      try {
        const QR = await import('qrcode'); // dynamic import
        const png = await QR.toDataURL(qrText, { margin: 1, scale: 6 });
        if (alive) setQrDataUrl(png);
      } catch {
        if (alive) setQrDataUrl(null);
      }
    }
    gen();
    return () => { alive = false; };
  }, [open, wallet, qrText]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold">Participate — {wallet?.chain || '...'}</h3>
            <p className="text-xs text-gray-500">
              Send a contribution to the address below. All data and addresses are public and verifiable.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-2 text-gray-500 hover:bg-gray-100"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex items-center justify-center rounded-xl border border-gray-200 p-3">
            {wallet && qrDataUrl ? (
              <img src={qrDataUrl} alt="QR code" className="h-40 w-40" />
            ) : loading ? (
              <div className="text-xs text-gray-500">Generating QR…</div>
            ) : (
              <div className="text-xs text-gray-500">QR unavailable</div>
            )}
          </div>

          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-gray-600">Address</div>
              <div className="mt-1 break-all rounded-lg border border-gray-200 bg-gray-50 p-2 font-mono text-xs">
                {wallet?.address || 'n/a'}
              </div>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="rounded-lg border border-gray-200 px-3 py-1 text-xs hover:bg-gray-50"
                  onClick={() => wallet?.address && navigator.clipboard.writeText(wallet.address)}
                >
                  Copy
                </button>
                {explorerUrl && (
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-gray-200 px-3 py-1 text-xs hover:bg-gray-50"
                  >
                    Open in explorer
                  </a>
                )}
              </div>
            </div>

            {wallet?.memo_tag && (
              <div>
                <div className="text-xs font-medium text-gray-600">Memo / Tag (required)</div>
                <div className="mt-1 rounded-lg border border-amber-200 bg-amber-50 p-2 font-mono text-xs text-amber-900">
                  {wallet.memo_tag}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 text-right">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-gray-900 px-4 py-1.5 text-sm text-white hover:bg-black"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

