// lib/evm.ts
export async function evmRpcCall<T = any>(
  url: string,
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

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
    cache: 'no-store',
  });

  if (!res.ok) throw new Error(`EVM RPC HTTP ${res.status} ${res.statusText}`);

  const json = await res.json();
  if (json.error) throw new Error(`EVM RPC error: ${JSON.stringify(json.error)}`);

  return json.result as T;
}

export async function getLatestBlockNumber(url: string, signal?: AbortSignal): Promise<number> {
  const hex = await evmRpcCall<string>(url, 'eth_blockNumber', [], signal);
  // hex → decimal
  return parseInt(hex, 16);
}

