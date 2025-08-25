// middleware.ts
import { NextResponse, NextRequest } from 'next/server';

// Public API scope we protect
const PUBLIC_PREFIX = '/api/public';

// Allowed origin in production
const PROD_ORIGIN = 'https://www.blockbattle.org';

// Simple per-IP token bucket (best-effort, per instance)
type Bucket = { tokens: number; last: number; capacity: number; refillMs: number };
const buckets: Map<string, Bucket> = (globalThis as any).__BB_BUCKETS__ ?? new Map();
(globalThis as any).__BB_BUCKETS__ = buckets;

function take(key: string, capacity: number, refillMs: number) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: capacity, last: now, capacity, refillMs };
    buckets.set(key, b);
  }
  const elapsed = now - b.last;
  if (elapsed > 0) {
    const refill = (elapsed / b.refillMs) * b.capacity;
    b.tokens = Math.min(b.capacity, b.tokens + refill);
    b.last = now;
  }
  if (b.tokens < 1) return { ok: false, remaining: 0, retryAfter: Math.ceil(b.refillMs / b.capacity) };
  b.tokens -= 1;
  return { ok: true, remaining: Math.floor(b.tokens) };
}

function getClientIp(req: NextRequest) {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  // Vercel sets x-real-ip sometimes
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

function ruleFor(pathname: string) {
  // per-route limits
  if (pathname.startsWith('/api/public/overview')) {
    return { cap: 60, refillMs: 5 * 60 * 1000, name: 'overview' }; // 60 / 5min / IP
  }
  if (pathname.startsWith('/api/public/chain/')) {
    return { cap: 120, refillMs: 5 * 60 * 1000, name: 'chain' }; // 120 / 5min / IP
  }
  // default public
  return { cap: 60, refillMs: 5 * 60 * 1000, name: 'public' };
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Only guard public API
  if (!pathname.startsWith(PUBLIC_PREFIX)) {
    return NextResponse.next();
  }

  const origin = req.headers.get('origin') || '';
  const isProd = process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production';
  const allowOrigin = isProd ? PROD_ORIGIN : origin || '*';

  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: corsHeaders });
  }

  // Rate-limit
  const { cap, refillMs, name } = ruleFor(pathname);
  const ip = getClientIp(req);
  const key = `${name}:${ip}`;
  const res = take(key, cap, refillMs);
  if (!res.ok) {
    const r = NextResponse.json(
      { ok: false, error: 'Too Many Requests' },
      { status: 429 }
    );
    r.headers.set('Retry-After', String(res.retryAfter));
    r.headers.set('X-RateLimit-Limit', String(cap));
    r.headers.set('X-RateLimit-Remaining', '0');
    Object.entries(corsHeaders).forEach(([k, v]) => r.headers.set(k, v));
    return r;
  }

  // Pass through and attach CORS + RL headers
  const next = NextResponse.next();
  next.headers.set('X-RateLimit-Limit', String(cap));
  next.headers.set('X-RateLimit-Remaining', String(res.remaining));
  Object.entries(corsHeaders).forEach(([k, v]) => next.headers.set(k, v));
  return next;
}

// Only run middleware for public API
export const config = {
  matcher: ['/api/public/:path*'],
};

