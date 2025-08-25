// lib/providers/btc/blockbook.ts
// NowNodes Blockbook provider (Bitcoin)
// Minimal API da bude drop-in zamjena za blockstream.ts exports

export type BtcTx = {
  txid: string;
  blockHeight: number;
  timestamp?: number | null;
  valueSats: number; // ukupno primljeno na target adresu u tom tx-u (u satoshijima)
};

function noTrailingSlash(s: string) {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}

function headersFor(urlStr: string) {
  const h: Record<string, string> = { Accept: 'application/json' };
  try {
    const u = new URL(urlStr);
    if (u.hostname.endsWith('nownodes.io') && process.env.NOWNODES_API_KEY) {
      h['api-key'] = process.env.NOWNODES_API_KEY!;
    }
  } catch {}
  return h;
}

// Precizna konverzija BTC decimal string -> sats (bez floating pointa)
function btcToSats(val: string): number {
  const [i, f = ''] = String(val).split('.');
  const fi = (f + '00000000').slice(0, 8);
  const big = BigInt(i) * 100000000n + BigInt(fi);
  // vrijednosti outputa su < 21e14 sat; fit-a u JS number
  return Number(big);
}

// Dohvati transakcije s Blockbook /address endpointa i filtriraj one gdje target adresa prima iznos
async function getAddressTxs(base: string, address: string, pageSize = 100) {
  const url = `${noTrailingSlash(base)}/api/v2/address/${encodeURIComponent(
    address
  )}?pageSize=${pageSize}&details=txs`;
  const res = await fetch(url, { headers: headersFor(url), cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Blockbook HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Vrati sve "incoming" tx-ove za adresu, opcijski samo iznad `minBlockHeight`.
 * Pod incoming računamo zbroj svih vout vrijednosti gdje je target adresa u listi `addresses`.
 */
export async function fetchIncomingForAddress(
  address: string,
  minBlockHeight?: number
): Promise<BtcTx[]> {
  const base =
    process.env.BTC_BLOCKBOOK_URL?.trim() || 'https://btc-blockbook.nownodes.io';

  const json = await getAddressTxs(base, address, 100);
  const txs: any[] = json?.txs || json?.transactions || [];

  const result: BtcTx[] = [];

  for (const tx of txs) {
    const height: number | null =
      typeof tx?.blockHeight === 'number' ? tx.blockHeight : null;
    if (!height || height <= 0) continue; // preskoči mempool

    if (
      typeof minBlockHeight === 'number' &&
      Number.isFinite(minBlockHeight) &&
      height <= minBlockHeight
    ) {
      continue;
    }

    let receivedSats = 0;
    const vout = Array.isArray(tx?.vout) ? tx.vout : [];
    for (const o of vout) {
      const val = o?.value ?? o?.valueZat; // Blockbook value je string BTC
      const addrs: string[] =
        o?.addresses ??
        (o?.address ? [o.address] : []) ??
        [];

      if (val != null && Array.isArray(addrs) && addrs.includes(address)) {
        // value je string BTC; pretvori u sats
        const sats =
          typeof val === 'string' ? btcToSats(val) : Number(val);
        if (Number.isFinite(sats)) receivedSats += sats;
      }
    }

    if (receivedSats > 0) {
      result.push({
        txid: tx?.txid || tx?.txId || tx?.hash,
        blockHeight: height,
        timestamp:
          typeof tx?.blockTime === 'number'
            ? tx.blockTime
            : typeof tx?.time === 'number'
            ? tx.time
            : null,
        valueSats: receivedSats,
      });
    }
  }

  // sortiraj uzlazno po visini
  result.sort((a, b) => a.blockHeight - b.blockHeight);
  return result;
}

