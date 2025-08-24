// lib/rpc.ts
type Chain = 'BTC' | 'LTC' | 'DOGE';

const chainSub: Record<Chain, string> = {
  BTC: 'btc',
  LTC: 'ltc',
  DOGE: 'doge',
};

function nownodesUrl(chain: Chain) {
  return `https://${chainSub[chain]}.nownodes.io`;
}

function nownodesHeaders() {
  const key = process.env.NOWNODES_API_KEY || '';
  return {
    'Content-Type': 'application/json',
    'api-key': key,
  };
}

export async function rpcCall<T = any>(
  chain: Chain,
  method: string,
  params: any[] = [],
  signal?: AbortSignal
): Promise<T> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: Date.now(),
    method,
    params,
  });

  const url = nownodesUrl(chain);
  const res = await fetch(url, {
    method: 'POST',
    headers: nownodesHeaders(),
    body,
    signal,
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  }
  return json.result as T;
}

