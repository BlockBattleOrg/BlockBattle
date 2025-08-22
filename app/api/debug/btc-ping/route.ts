import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const base = (process.env.BTC_API_BASE || "https://mempool.space/api").trim();
  const url = `${base}/blocks/tip/height`; // mali i jeftin endpoint

  try {
    const r = await fetch(url, { cache: "no-store" });
    const txt = await r.text();
    return NextResponse.json({
      ok: r.ok,
      base,
      url,
      status: r.status,
      sample: txt.slice(0, 80)
    });
  } catch (e: any) {
    return NextResponse.json({
      ok: false,
      base,
      urlTried: url,
      error: String(e?.message || e)
    }, { status: 500 });
  }
}

