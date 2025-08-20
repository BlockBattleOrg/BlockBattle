// lib/utils/retry.ts
/**
 * Minimal HTTP fetch retry with exponential backoff for 429/5xx.
 * Keeps code small and friendly to free-rate limits.
 */
export async function fetchWithBackoff(
  url: string,
  init?: RequestInit,
  tries = 3
): Promise<Response> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    const res = await fetch(url, init);
    if (res.ok) return res;

    // Retry only for rate-limit or transient server errors
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status} on ${url}`);
      // 0.5s, 1s, 2s ...
      const delayMs = 500 * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    // For other statuses do not retry
    throw new Error(`HTTP ${res.status} on ${url}`);
  }
  throw lastErr ?? new Error(`Network error on ${url}`);
}

