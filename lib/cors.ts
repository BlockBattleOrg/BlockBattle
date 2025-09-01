// lib/cors.ts
import { NextRequest, NextResponse } from "next/server";

function parseAllowlist(): string[] {
  // Comma-separated origins, e.g.:
  // https://www.blockbattle.org,https://blockbattle-org.vercel.app,http://localhost:3000
  const raw = process.env.CORS_ALLOWLIST ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin: string, allowlist: string[]): boolean {
  if (!origin) return false;
  if (allowlist.includes("*")) return true; // wildcard
  return allowlist.includes(origin);
}

export function applyCors(res: NextResponse, origin: string, req: NextRequest) {
  const allowlist = parseAllowlist();
  const isSameOrigin = !origin; // server-to-server

  const allowOriginHeader =
    isSameOrigin || isAllowedOrigin(origin, allowlist) ? origin || "*" : "";

  if (!allowOriginHeader) return; // soft deny: no CORS headers

  const allowMethods = "GET,POST,OPTIONS";
  const allowHeaders =
    req.headers.get("access-control-request-headers") ||
    "authorization,content-type";

  res.headers.set("Access-Control-Allow-Origin", allowOriginHeader);
  res.headers.set("Vary", "Origin");
  res.headers.set("Access-Control-Allow-Methods", allowMethods);
  res.headers.set("Access-Control-Allow-Headers", allowHeaders);
  res.headers.set("Access-Control-Allow-Credentials", "true");
  res.headers.set("Access-Control-Max-Age", "600");
}

