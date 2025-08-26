// app/api/public/wallets/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

function norm(q: string | null | undefined) {
  const s = String(q || "").trim().toUpperCase();
  if (!s) return "";
  if (s === "POLYGON" || s === "MATIC") return "POL";
  return s;
}

export async function GET(req: Request) {
  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
    }
    const url = new URL(req.url);
    const chainQ = norm(url.searchParams.get("chain")); // e.g. pol
    if (!chainQ) {
      return NextResponse.json({ ok: false, error: "Missing ?chain" }, { status: 400 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // Pokrij i currencies.symbol i wallets.chain (razni sinonimi)
    const symbols = [chainQ, chainQ === "POL" ? "MATIC" : ""].filter(Boolean);
    const chains = [chainQ, chainQ === "POL" ? "MATIC" : "", chainQ === "POL" ? "POLYGON" : ""]
      .filter(Boolean)
      .map((x) => x.toLowerCase());

    const { data, error } = await sb
      .from("wallets")
      .select(
        `
          id, address, chain, is_active, currency_id,
          currencies ( symbol )
        `
      )
      .eq("is_active", true);

    if (error) throw error;

    // Filtar u aplikaciji (fleksibilnije)
    const candidates =
      (data || []).filter((w: any) => {
        const sym = String(w?.currencies?.symbol || "").toUpperCase();
        const chn = String(w?.chain || "").toUpperCase();
        const matchSym = !!sym && symbols.includes(sym);
        const matchChn = !!chn && symbols.includes(chn) || chains.includes(chn.toLowerCase());
        return matchSym || matchChn;
      }) ?? [];

    // Preferiraj one s currency_id (stabilniji joinovi), ali vrati bilo koji aktivni
    candidates.sort((a: any, b: any) => Number(Boolean(b.currency_id)) - Number(Boolean(a.currency_id)));

    const wallet = candidates[0] || null;
    return NextResponse.json({ ok: true, wallets: wallet ? [wallet] : [] });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Wallets API error" }, { status: 500 });
  }
}

