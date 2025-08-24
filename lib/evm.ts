// lib/evm.ts
function buildHeaders(urlStr: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const u = new URL(urlStr);
    // NOWNodes: dozvoli header auth ako ključ nije u putanji
    if (u.hostname.endsWith('nownodes.io')) {
      const hasKeyInPath = /\/[A-Za-z0-9_-]{16,}$/.test(u.pathname);
      if (!hasKeyInPath && process.env.NOWNODES_API_KEY) {
        headers['api-key'] = process.env.NOWNODES_API_KEY;
      }
    }
    // GetBlock (ako ga ikad koristiš za EVM)
    if (u.hostname.includes('getblock.io') && process.env.GETBLOCK_API_KEY) {
      headers['x-api-key'] = process.env.GETBLOCK_API_KEY;
    }
  } catch (_) {}
  return headers;
}

export async function evmRpcCall<T = any>(
  url: string,
  method: string,
  params: any[] = [],
  signal?: AbortSignal
): Promise<T> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params });
  const res = await fetch(url, { method: 'POST', headers: buildHeaders(url), body, signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`EVM RPC HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.error) throw new Error(`EVM RPC error: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

export async function getLatestBlockNumber(url: string, signal?: AbortSignal): Promise<number> {
  const hex = await evmRpcCall<string>(url, 'eth_blockNumber', [], signal);
  return parseInt(hex, 16);
}

