// app/api/ingest/contrib/atom/route.ts
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Small helper to build JSON responses with consistent headers.
 */
function json(data: unknown, status = 200, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...init?.headers,
    },
  });
}

/**
 * POST /api/ingest/contrib/atom
 *
 * Orchestrator for ATOM ingest:
 *  - validates x-cron-secret
 *  - forwards original query string and body to /api/ingest/atom (worker)
 *  - normalizes the response to contrib contract
 */
export async function POST(req: NextRequest): Promise<Response> {
  const startedAt = Date.now();

  try {
    // 1) Validate secret (same convention as other contrib routes)
    const provided = req.headers.get("x-cron-secret") || "";
    const expected = process.env.CRON_SECRET || "";
    if (!expected) {
      return json(
        {
          ok: false,
          error: "Missing CRON_SECRET",
          detail: "Environment variable CRON_SECRET is not set.",
          durationMs: Date.now() - startedAt,
        },
        500
      );
    }
    if (provided !== expected) {
      return json(
        {
          ok: false,
          error: "Unauthorized",
          detail:
            "Invalid or missing x-cron-secret. Access denied for contrib ingest.",
          durationMs: Date.now() - startedAt,
        },
        401
      );
    }

    // 2) Build worker URL and forward original search params
    const url = new URL(req.url);
    const origin = url.origin;
    const search = url.search; // includes leading "?" if present
    const workerUrl = `${origin}/api/ingest/atom${search}`;

    // 3) Forward original body if present
    let body: BodyInit | undefined = undefined;
    let contentType = req.headers.get("content-type") || "";
    if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
      if (contentType.includes("application/json")) {
        const jsonBody = await req.json().catch(() => null);
        body = jsonBody ? JSON.stringify(jsonBody) : undefined;
      } else if (contentType.includes("application/x-www-form-urlencoded")) {
        const formData = await req.formData().catch(() => null);
        if (formData) {
          const params = new URLSearchParams();
          for (const [k, v] of formData.entries()) {
            params.append(k, String(v));
          }
          body = params.toString();
        }
      } else if (contentType.includes("text/plain")) {
        body = await req.text().catch(() => undefined);
      } else {
        // As a safe default try to read as text; if empty, leave undefined
        body = await req.text().catch(() => undefined);
      }
    }

    // 4) Call worker; forward minimal headers (secret + content-type if we have a body)
    const headers: Record<string, string> = {
      "x-cron-secret": provided,
      "cache-control": "no-store",
    };
    if (body && contentType) headers["content-type"] = contentType;

    const res = await fetch(workerUrl, {
      method: "POST",
      headers,
      body,
      cache: "no-store",
    });

    // 5) Parse worker payload (json preferred, fallback to text)
    let payload: any = null;
    const resCT = res.headers.get("content-type") || "";
    if (resCT.includes("application/json")) {
      payload = await res.json().catch(async () => ({ raw: await res.text() }));
    } else {
      payload = { raw: await res.text() };
    }

    // 6) Normalize response for contrib contract
    if (!res.ok) {
      const detail =
        payload?.detail ??
        payload?.error ??
        payload?.message ??
        payload?.raw ??
        "ATOM ingest worker responded with non-200 status.";

      return json(
        {
          ok: false,
          error: "ATOM ingest failed",
          detail,
          status: res.status,
          durationMs: Date.now() - startedAt,
        },
        200
      );
    }

    return json(
      {
        ok: true,
        chain: "cosmos",
        symbol: "ATOM",
        result: payload ?? null,
        durationMs: Date.now() - startedAt,
      },
      200
    );
  } catch (err: any) {
    return json(
      {
        ok: false,
        error: "Unhandled exception in contrib/atom",
        detail: err?.message ?? String(err),
        durationMs: Date.now() - startedAt,
      },
      500
    );
  }
}

/**
 * Optional guard for GET (kept consistent with other contrib routes).
 */
export async function GET() {
  return json(
    {
      ok: false,
      error: "Method Not Allowed",
      detail: "Use POST for /api/ingest/contrib/atom",
    },
    405
  );
}

