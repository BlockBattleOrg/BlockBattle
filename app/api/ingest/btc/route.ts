// app/api/ingest/btc/route.ts
import { NextRequest, NextResponse } from "next/server";
import { runBtcIngestion } from "@/lib/ingestion/btc";

export const dynamic = "force-dynamic"; // ensure runtime execution, avoid build-time evaluation

/**
 * Auth check for GitHub Actions / (or Vercel Cron if re-enabled):
 * - Set CRON_SECRET in environment
 * - Caller must send: Authorization: Bearer <CRON_SECRET>
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

