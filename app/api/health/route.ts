import { NextResponse } from "next/server";

// Force Node runtime (so env is available) and avoid static rendering
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    ok: true,
    now: new Date().toISOString(),
    // short commit if running on Vercel
    rev: (process.env.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || null,
    env: {
      // only presence flags; no values are leaked
      hasCronSecret: Boolean((process.env.CRON_SECRET || "").trim()),
      hasSupabaseUrl: Boolean((process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim()),
      hasSupabaseSrk: Boolean((process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim()),
    },
  });
}

