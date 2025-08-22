// lib/providers/btc/blockstream.ts
// Provider for Bitcoin address txs using Mempool.space or Blockstream.
// Expects BTC_API_BASE env (e.g. https://mempool.space/api or https://blockstream.info/api)

export type BtcTx = {
  txid: string;
  satoshis: number;     // amount received by the address in this tx (sum of relevant vout)
  timestamp: string;    // ISO string
};

/**
 * Returns latest incoming txs for an address.
 * We consider "incoming" as sum of vout amounts where vout.address == address.
 * Mempool-space & Blockstream return very similar shapes.
 */
export async function fetchIncomingForAddress(address: string): Promise<BtcTx[]> {
  const base = (process.env.BTC_API_BASE || "").trim();
  const usingBase = base || "https://mempool.space/api"; // default fallback
  const url = `${usingBase}/address/${encodeURIComponent(address)}/txs`;

  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store" });
  } catch (e: any) {
    // Bubble a useful error so we see the base URL in logs
    throw new Error(`BTC fetch failed at ${url}: ${e?.message || e}`);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`BTC provider HTTP ${res.status} at ${url}: ${text.slice(0, 200)}`);
  }

  // Expect array of txs. For mempool.space, fields used:
  // txid, vout: [{ value: satoshis, scriptpubkey_address: string }], status: { block_time: number }
  const json = await res.json();
  if (!Array.isArray(json)) return [];

  const out: BtcTx[] = [];
  for (const tx of json) {
    const vout = Array.isArray(tx?.vout) ? tx.vout : [];
    let sat = 0;
    for (const o of vout) {
      const a = o?.scriptpubkey_address;
      const v = typeof o?.value === "number" ? o.value : 0;
      if (a && a === address) sat += v;
    }
    if (sat <= 0) continue;

    const sec = Number(tx?.status?.block_time);
    const iso = Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : new Date().toISOString();

    out.push({
      txid: String(tx?.txid || ""),
      satoshis: sat,
      timestamp: iso,
    });
  }

  return out;
}

