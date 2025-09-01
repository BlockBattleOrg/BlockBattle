// app/api/public/health/route.ts
import { NextResponse } from "next/server";

export const runtime = "edge"; // fast + aligns with middleware

export async function GET() {
  const now = new Date().toISOString();
  const rateLimitEnabled =
    !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;

  const body = {
    ok: true,
    service: "public-health",
    ts: now,
    rateLimitEnabled,
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
  };

  return NextResponse.json(body, {
    status: 200,
    headers: {
      // small/no cache for a health probe
      "Cache-Control": "public, max-age=0, must-revalidate",
    },
  });
}

