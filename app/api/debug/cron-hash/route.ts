import { NextResponse } from "next/server";
import { createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const raw = (process.env.CRON_SECRET || "").trim();
  const envPresent = raw.length > 0;
  const hash = raw ? createHash("sha256").update(raw).digest("hex") : null;
  return NextResponse.json({ envPresent, hash });
}

