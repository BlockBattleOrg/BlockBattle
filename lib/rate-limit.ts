// lib/rate-limit.ts
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

// Singleton limiter instance for Edge Runtime
let _limiter: Ratelimit | null | undefined;

export function getRateLimiter(): Ratelimit | null {
  // Return cached instance (null or existing)
  if (_limiter !== undefined) return _limiter;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // No envs => disable rate limiting, keep CORS
    _limiter = null;
    return _limiter;
  }

  const redis = new Redis({ url, token });

  // Policy: 60 requests / 5 minutes (sliding window)
  _limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, "5 m"),
    prefix: "rrl:public",
    analytics: false,
  });

  return _limiter;
}

