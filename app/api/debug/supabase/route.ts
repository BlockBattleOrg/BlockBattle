import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL || "").trim();
  const srk = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

  const envPresent = {
    NEXT_PUBLIC_SUPABASE_URL: Boolean(url),
    SUPABASE_SERVICE_ROLE_KEY: Boolean(srk),
  };

  if (!url || !srk) {
    return NextResponse.json(
      { ok: false, envPresent, error: "Missing Supabase admin env" },
      { status: 500 }
    );
  }

  try {
    const supabase = createClient(url, srk, { auth: { persistSession: false } });

    // Minimalan upit: dohvati 1 wallet, samo polja koja ne otkrivaju ništa osjetljivo
    const { data, error } = await supabase
      .from("wallets")
      .select("id,address,chain,is_active")
      .limit(1);

    if (error) {
      return NextResponse.json(
        { ok: false, envPresent, step: "select wallets", error: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, envPresent, sample: data ?? [] });
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        envPresent,
        step: "supabase client fetch",
        error: String(e?.message || e),
      },
      { status: 500 }
    );
  }
}

