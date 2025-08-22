import { NextRequest, NextResponse } from "next/server";
import { runBtcIngestion } from "@/lib/ingestion/btc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Accept multiple auth formats to be robust across schedulers/proxies:
 * - Authorization: Bearer <CRON_SECRET>
 * - x-cron-secret: <CRON_SECRET>
 * - x-ingest-secret: <CRON_SECRET>
 * - ?secret=<CRON_SECRET> (fallback)
 */
function isAuthorized(req: NextRequest): boolean {
  const expected = (process.env.CRON_SECRET || "").trim();
  if (!expected) return false;

  const auth = (req.headers.get("authorization") || "").trim();
  if (auth === `Bearer ${expected}`) return true;

  const x1 = (req.headers.get("x-cron-secret") || "").trim();
  if (x1 && x1 === expected) return true;

  const x2 = (req.headers.get("x-ingest-secret") || "").trim();
  if (x2 && x2 === expected) return true;

  const url = new URL(req.url);
  const qp = (url.searchParams.get("secret") || "").trim();
  if (qp && qp === expected) return true;

  return false;
}

export async function POST(req: NextRequest) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await runBtcIngestion();
    // result već sadrži { ok: true, ... }, pa samo vrati njega
    return NextResponse.json(result);
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}

