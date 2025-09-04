// app/api/admin/fx-sync/route.ts
import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type FXMap = Record<string, number>;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ENV: ${name}`);
  return v;
}
function maybe(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length ? v : undefined;
}

// --- Alias mapa (bez novih tablica) ---
// kanonski ključ = vrijednosti koje želiš imati u “FX mapi” i agregatima
// (usklađeno s tvojim currencies.symbol setom: BTC, ETH, POL, BNB, SOL, ARB, OP, AVAX, ATOM, DOT, LTC, TRX, XLM, XRP, DOGE)
const ALIAS_TO_CANON: Record<string, string> = {
  // BTC
  "btc": "BTC", "bitcoin": "BTC",

  // ETH
  "eth": "ETH", "ethereum": "ETH",

  // POL / MATIC / POLYGON
  "pol": "POL", "matic": "POL", "polygon": "POL",

  // BNB / BSC / BINANCE
  "bnb": "BNB", "bsc": "BNB", "binance": "BNB",

  // SOL
  "sol": "SOL", "solana": "SOL",

  // ARB
  "arb": "ARB", "arbitrum": "ARB",

  // OP
  "op": "OP", "optimism": "OP",

  // AVAX
  "avax": "AVAX", "avalanche": "AVAX",

  // ATOM (Cosmos)
  "atom": "ATOM", "cosmos": "ATOM",

  // DOT (Polkadot)
  "dot": "DOT", "polkadot": "DOT",

  // LTC (Litecoin)
  "ltc": "LTC", "litecoin": "LTC",

  // TRX (Tron)
  "trx": "TRX", "tron": "TRX",

  // XLM (Stellar)
  "xlm": "XLM", "stellar": "XLM",

  // XRP (Ripple)
  "xrp": "XRP", "ripple": "XRP",

  // DOGE (Dogecoin)
  "doge": "DOGE", "dogecoin": "DOGE",
};

function canon(x?: string | null): string | undefined {
  if (!x) return undefined;
  const low = x.trim().toLowerCase();
  // ako je već kanonski simbol (npr. "ETH"), respektiraj
  const upper = x.trim().toUpperCase();
  if (ALIAS_TO_CANON[low]) return ALIAS_TO_CANON[low];
  // ako je već kanonski (BTC/ETH/POL/BNB/...), vrati ga
  if (ALIAS_TO_CANON[upper?.toLowerCase?.()] === upper) return upper;
  // fallback: ako nije u alias mapi, pokušaj uppercase kao kanon
  return upper || undefined;
}

function supa(): SupabaseClient {
  return createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

async function parseFxFromQuery(url: URL): Promise<FXMap> {
  const fxParam = url.searchParams.get("fx") || "";
  const out: FXMap = {};

  // 1) fx=POL:0.51,ETH:2400,BNB:520 ...
  if (fxParam) {
    for (const part of fxParam.split(",")) {
      const [k0, v0] = part.split(":");
      const c = canon(k0);
      const n = Number((v0 || "").trim());
      if (c && Number.isFinite(n) && n > 0) out[c] = n; // zadnji dobiva prednost
    }
  }

  // 2) opcionalno: PRICE_FEED_URL -> { "POL": 0.51, "ETH": 2400, ... }
  if (Object.keys(out).length === 0) {
    const feed = maybe("PRICE_FEED_URL");
    if (feed) {
      try {
        const res = await fetch(feed, { headers: { accept: "application/json" } });
        if (res.ok) {
          const j = await res.json() as Record<string, any>;
          for (const [k, v] of Object.entries(j || {})) {
            const c = canon(k);
            const n = Number(v as any);
            if (c && Number.isFinite(n) && n > 0) out[c] = n;
          }
        }
      } catch {
        // ignore, ostavi out prazan
      }
    }
  }

  return out;
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const secret = req.headers.get("x-cron-secret") || "";
    if (secret !== need("CRON_SECRET")) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const client = supa();

    // modes
    const mode = (url.searchParams.get("mode") || "missing").toLowerCase(); // "missing" | "reprice"
    const hours = Math.max(1, Number(url.searchParams.get("hours") || "24")); // for mode=missing
    const days  = Math.max(1, Number(url.searchParams.get("days")  || "30")); // for mode=reprice
    const limit = Math.max(100, Math.min(5000, Number(url.searchParams.get("limit") || "2000")));

    // opcionalni filter: chain=POL,ETH,BNB (bilo koji alias; kanoniziramo ispod)
    const chainFilterRaw = (url.searchParams.get("chain") || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    const chainFilter = chainFilterRaw
      .map(canon)
      .filter((x): x is string => !!x);

    // FX mappa (kanonizirani ključevi)
    const fx = await parseFxFromQuery(url);
    if (!fx || Object.keys(fx).length === 0) {
      return NextResponse.json({ ok: false, error: "No FX map provided (?fx=POL:0.51,ETH:2400,BNB:520 or PRICE_FEED_URL)" }, { status: 400 });
    }

    // wallets -> id -> chain (kanonizirano)
    const { data: wallets, error: werr } = await client
      .from("wallets")
      .select("id, chain");
    if (werr) throw new Error(`wallets: ${werr.message}`);

    const idToChain = new Map<string, string>();
    for (const w of wallets || []) {
      const c = canon((w as any).chain);
      if (c) idToChain.set(String((w as any).id), c);
    }

    // vremenski prozor
    const now = Date.now();
    const sinceIso = mode === "missing"
      ? new Date(now - hours * 3600_000).toISOString()
      : new Date(now - days  * 86400_000).toISOString();

    // bazni SELECT
    let sel = client
      .from("contributions")
      .select("id, wallet_id, amount, amount_usd, block_time")
      .gte("block_time", sinceIso)
      .order("block_time", { ascending: false })
      .limit(limit);

    if (mode === "missing") sel = sel.is("amount_usd", null);

    const { data: rows, error: rerr } = await sel;
    if (rerr) throw new Error(`select contributions: ${rerr.message}`);

    // filtriraj po chain filteru (ako je zadan), i po tome da wallet postoji i ima kanonski chain
    const pool = (rows || []).filter(r => {
      const cid = (r as any).wallet_id ? idToChain.get(String((r as any).wallet_id)) : undefined;
      if (!cid) return false; // ignoriši retke bez valjanog wallet chain mapiranja
      if (chainFilter.length) return chainFilter.includes(cid);
      return true;
    });

    // per-row UPDATE (bez upserta; ne diramo tx_hash i ostale NOT NULL kolone)
    let considered = 0;
    let updated = 0;

    for (const r of pool) {
      considered++;
      const wid = String((r as any).wallet_id);
      const chainCanon = idToChain.get(wid)!; // postoji po filteru
      const price = fx[chainCanon];
      if (!price) continue; // ako nema cijene za taj kanon, preskoči

      const amt = Number((r as any).amount);
      if (!Number.isFinite(amt)) continue;

      const usd = amt * price;
      const { error: uerr } = await client
        .from("contributions")
        .update({ amount_usd: usd })
        .eq("id", (r as any).id);
      if (uerr) throw new Error(`update id=${(r as any).id}: ${uerr.message}`);
      updated++;
    }

    return NextResponse.json({
      ok: true,
      mode,
      since: sinceIso,
      considered,
      updated,
      fxKeys: Object.keys(fx),           // npr. ["POL","ETH","BNB",...]
      chainFilter: chainFilter.length ? chainFilter : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

