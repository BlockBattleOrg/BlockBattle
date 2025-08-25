// lib/providers/btc/blockbook.ts
// NowNodes Blockbook provider (Bitcoin)
// Kompatibilan sa starim providerom: izvozimo satoshis + ISO timestamp

export type BtcTx = {
  txid: string;
  blockHeight: number;
  // kompatibilnost sa starim ingestion kodom:
  satoshis: number;            // ukupno primljeno na target adresu (u satoshijima)
  timestamp: string | null;    // ISO string (ili null)
  // dodatno ostavljamo i valueSats (nije nužno, ali ne smeta)
  valueSats?: number;
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
  return Number(big);
}

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
 * "Incoming" = zbroj svih outputa gdje se target adresa pojavljuje u listi adresa outputa.
 */
export async function fetchIncomingForAddress(
  address: string,
  minBlockHeight?: number
): Promise<BtcTx[]> {
  const base =
    process.env.BTC_BLOCKBOOK_URL?.trim() || 'https://btc-blockbook.nownodes.io';

  const json = await getAddressTxs(base, address, 100);
  const txs: any[] = json?.txs || json?.transactions || [];

  const out: BtcTx[] = [];

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
      // Blockbook value je string BTC; ponekad postoji i valueZat
      const val = o?.value ?? o?.valueZat;
      const addrs: string[] =
        (Array.isArray(o?.addresses) && o.addresses) ||
        (o?.address ? [o.address] : []);

      if (val != null && addrs.includes(address)) {
        const sats =
          typeof val === 'string' ? btcToSats(val) : Number(val);
        if (Number.isFinite(sats)) receivedSats += sats;
      }
    }

    if (receivedSats > 0) {
      // timestamp -> ISO string
      const tsSec =
        typeof tx?.blockTime === 'number'
          ? tx.blockTime
          : typeof tx?.time === 'number'
          ? tx.time
          : null;
      const iso = tsSec ? new Date(tsSec * 1000).toISOString() : null;

      out.push({
        txid: tx?.txid || tx?.txId || tx?.hash,
        blockHeight: height,
        satoshis: receivedSats,
        timestamp: iso,
        valueSats: receivedSats,
      });
    }
  }

  out.sort((a, b) => a.blockHeight - b.blockHeight);
  return out;
}

