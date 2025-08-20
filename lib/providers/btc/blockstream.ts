// lib/providers/btc/blockstream.ts
/**
 * Blockstream (free) adapter for incoming BTC transfers to a given address.
 * - Uses light pagination with an env-controlled page cap (default 1).
 * - Uses exponential backoff on 429/5xx to play nice with free limits.
 */

import { fetchWithBackoff } from "@/lib/utils/retry";

const BASE = process.env.BTC_API_BASE || "https://blockstream.info/api";
const MAX_PAGES = Number(process.env.BTC_MAX_PAGES || "1"); // keep PoC gentle by default

export type BtcTx = {
  txid: string;
  satoshis: number;      // positive for incoming (sum of vout to the address)
  timestamp: string;     // ISO string (UTC)
};

type BlockstreamTx = {
  txid: string;
  status: { confirmed: boolean; block_time?: number };
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
};

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetchWithBackoff(url, {
    headers: { "User-Agent": "BlockBattle-Ingest/1.0" },
  });
  return (await r.json()) as T;
}

/**
 * Fetch a page of transactions for an address.
 * First page:  GET /address/:addr/txs
 * Next pages:  GET /address/:addr/txs/chain?last_seen=:txid
 */
async function fetchAddressTxPage(address: string, lastSeen?: string): Promise<BlockstreamTx[]> {
  const url = lastSeen
    ? `${BASE}/address/${address}/txs/chain?last_seen=${lastSeen}`
    : `${BASE}/address/${address}/txs`;
  return fetchJson<BlockstreamTx[]>(url);
}

/**
 * Returns only incoming transfers to `address`.
 * NOTE (PoC): We sum all vouts paying to the address; self-send/change not filtered.
 */
export async function fetchIncomingForAddress(address: string): Promise<BtcTx[]> {
  const incoming: BtcTx[] = [];

  let page = 0;
  let lastSeen: string | undefined = undefined;

  while (page < MAX_PAGES) {
    const txs = await fetchAddressTxPage(address, lastSeen);
    if (!txs.length) break;

    for (const tx of txs) {
      let sumToAddress = 0;
      for (const vout of tx.vout) {
        if (vout.scriptpubkey_address === address) sumToAddress += vout.value || 0;
      }
      if (sumToAddress > 0) {
        const tsSec = tx.status?.block_time ?? Math.floor(Date.now() / 1000);
        incoming.push({
          txid: tx.txid,
          satoshis: sumToAddress,
          timestamp: new Date(tsSec * 1000).toISOString(),
        });
      }
    }

    // Prepare for the next page (Blockstream uses last txid to paginate the chain)
    lastSeen = txs[txs.length - 1]?.txid;
    // Defensive: if no progress possible, stop
    if (!lastSeen) break;

    page += 1;
  }

  return incoming;
}

