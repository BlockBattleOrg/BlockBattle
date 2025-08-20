// app/api/ingest/btc/route.ts
import { NextRequest, NextResponse } from "next/server";
import { runBtcIngestion } from "@/lib/ingestion/btc";

/**
 * Auth check for Vercel Cron:
 * - Set CRON_SECRET in Vercel Project → Settings → Environment Variables
 * - Vercel Cron will send: Authorization: Bearer <CRON_SECRET>
 */
function isAuthorized(req: NextRequest): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers.get("authorization") || "";
  return auth === `Bearer ${expected}`;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runBtcIngestion();
    return NextResponse.json({ ok: true, ...result });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}

/**
 * Optional GET for manual health check from Vercel Cron UI.
 * Remove if you prefer POST-only.
 */
export async function GET(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ ok: true, hint: "Use POST to run BTC ingestion." });
}

