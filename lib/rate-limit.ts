// lib/rate-limit.ts
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";

let _limiter: Ratelimit | null | undefined;

export function getRateLimiter(): Ratelimit | null {
  // Cache the instance across invocations in the Edge runtime
  if (_limiter !== undefined) return _limiter;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    // Graceful disable: without envs, rate limiting is off (CORS still works)
    _limiter = null;
    return _limiter;
  }

  const redis = new Redis({ url, token });

  // Policy: 60 requests per 5 minutes per IP (sliding window)
  _limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(60, "5 m"),
    prefix: "rrl:public",
    analytics: false,
  });

  return _limiter;
}

