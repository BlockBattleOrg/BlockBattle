// lib/cors.ts
import { NextRequest, NextResponse } from "next/server";

function parseAllowlist(): string[] {
  // Comma-separated origins. Example:
  // https://www.blockbattle.org,https://blockbattle-org.vercel.app,http://localhost:3000
  const raw = process.env.CORS_ALLOWLIST ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin: string, allowlist: string[]): boolean {
  if (!origin) return false;
  // Exact origin match or wildcard
  if (allowlist.includes("*")) return true;
  return allowlist.includes(origin);
}

export function applyCors(res: NextResponse, origin: string, req: NextRequest) {
  const allowlist = parseAllowlist();

  // Same-origin (server-to-server) if Origin missing
  const isSameOrigin = !origin;

  const allowOriginHeader =
    isSameOrigin || isAllowedOrigin(origin, allowlist) ? origin || "*" : "";

  // If not allowed, return without CORS headers (soft deny).
  if (!allowOriginHeader) return;

  const allowMethods = "GET,POST,OPTIONS";
  const allowHeaders =
    req.headers.get("access-control-request-headers") ||
    "authorization,content-type";

  res.headers.set("Access-Control-Allow-Origin", allowOriginHeader);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Methods", allowMethods);
  res.headers.set("Access-Control-Allow-Headers", allowHeaders);
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Access-Control-Max-Age", "600"); // cache preflight 10 min
}

