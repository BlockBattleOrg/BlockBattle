// app/api/debug/ingest-auth/route.ts
import { NextRequest, NextResponse } from "next/server";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const env = (process.env.CRON_SECRET || "").trim();
  const envPresent = env.length > 0;

  const auth = (req.headers.get("authorization") || "").trim();
  const xCron = (req.headers.get("x-cron-secret") || "").trim();
  const url = new URL(req.url);
  const qp = (url.searchParams.get("secret") || "").trim();

  return NextResponse.json({
    envPresent,
    envLength: env.length,
    gotAuthorization: auth.length > 0,
    authStartsWithBearer: auth.startsWith("Bearer "),
    gotXcron: xCron.length > 0,
    gotQueryParam: qp.length > 0
  });
}

