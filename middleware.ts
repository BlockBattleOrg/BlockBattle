// middleware.ts
import { NextRequest, NextResponse } from "next/server";
import { applyCors } from "./lib/cors";
import { getRateLimiter } from "./lib/rate-limit";

// Run only for public API routes
export const config = {
  matcher: ["/api/public/:path*"],
};

export async function middleware(req: NextRequest) {
  const origin = req.headers.get("origin") || "";
  const method = req.method.toUpperCase();

  // 1) Handle CORS preflight early
  if (method === "OPTIONS") {
    const res = new NextResponse(null, { status: 204 });
    applyCors(res, origin, req);
    return res;
  }

  // 2) Lightweight rate limiting (graceful fallback if env vars are missing)
  try {
    const limiter = getRateLimiter();
    if (limiter) {
      // Use client IP (works behind Vercel’s proxy)
      const ip =
        req.ip ??
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        req.headers.get("x-real-ip") ??
        "0.0.0.0";

      // Example policy: 60 requests / 5 minutes per IP (sliding window)
      const { success, limit, remaining, reset } = await limiter.limit(ip);

      if (!success) {
        const retryAfter = Math.max(0, Math.ceil((reset - Date.now()) / 1000));
        const res = NextResponse.json(
          { ok: false, error: "Rate limit exceeded. Please try again later." },
          { status: 429 }
        );
        applyCors(res, origin, req);
        res.headers.set("Retry-After", String(retryAfter));
        res.headers.set("X-RateLimit-Limit", String(limit));
        res.headers.set("X-RateLimit-Remaining", String(remaining));
        res.headers.set("X-RateLimit-Reset", String(Math.floor(reset / 1000)));
        return res;
      }
    }
  } catch {
    // If limiter init fails (e.g., missing envs), continue without rate limiting
  }

  // 3) Forward to route handler; attach CORS headers on the way out
  const res = NextResponse.next();
  applyCors(res, origin, req);
  return res;
}

