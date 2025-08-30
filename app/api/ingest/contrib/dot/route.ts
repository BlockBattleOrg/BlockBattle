// app/api/ingest/contrib/dot/route.ts
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Thin proxy to the first-party DOT ingest route.
 * Mirrors the status code and JSON body from /api/ingest/dot.
 * Accepts:
 *  - header: x-cron-secret
 *  - query:  ?address=...
 *  - body:   { address?: string }
 */
function json(data: any, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readJsonBody(req: NextRequest): Promise<any | null> {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return null;
  try {
    const obj = await req.json();
    return obj && typeof obj === "object" ? obj : null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const startedAt = Date.now();
  try {
    // Compose target URL on the same origin
    const url = new URL(req.url);
    const origin = `${url.protocol}//${url.host}`;
    const target = new URL(`${origin}/api/ingest/dot`);

    // Forward address override if present (query or body)
    const qsAddr = url.searchParams.get("address");
    if (qsAddr) target.searchParams.set("address", qsAddr);

    // Forward only the needed headers
    const secret = req.headers.get("x-cron-secret") || "";
    const headers: Record<string, string> = {
      accept: "application/json",
      "cache-control": "no-store",
      ...(secret ? { "x-cron-secret": secret } : {}),
    };

    // Forward JSON body if provided
    const body = await readJsonBody(req);
    const init: RequestInit = {
      method: "POST",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    };

    const res = await fetch(target.toString(), init);
    const ct = res.headers.get("content-type") || "";

    // Mirror status & body
    if (ct.includes("application/json")) {
      const data = await res.json();
      return json(data, res.status);
    } else {
      const raw = await res.text();
      return json({ ok: false, passthrough: true, raw }, res.status);
    }
  } catch (err: any) {
    return json(
      {
        ok: false,
        error: "Unhandled exception in /api/ingest/contrib/dot",
        detail: err?.message ?? String(err),
        durationMs: Date.now() - startedAt,
      },
      500
    );
  }
}

export async function GET() {
  return json({ ok: false, error: "Method Not Allowed", detail: "Use POST" }, 405);
}

