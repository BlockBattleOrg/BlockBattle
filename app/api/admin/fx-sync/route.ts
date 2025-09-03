// app/api/admin/fx-sync/route.ts
import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Chain = string;
type FXMap = Record<Chain, number>;

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ENV: ${name}`);
  return v;
}
function maybe(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length ? v : undefined;
}
function lc(x?: string | null) { return (x || "").toLowerCase(); }
function up(x?: string | null) { return (x || "").toUpperCase(); }

function supa(): SupabaseClient {
  return createClient(need("NEXT_PUBLIC_SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

async function parseFxFromQuery(url: URL): Promise<FXMap> {
  const fxParam = url.searchParams.get("fx") || "";
  const out: FXMap = {};
  if (fxParam) {
    for (const part of fxParam.split(",")) {
      const [rawK, rawV] = part.split(":");
      const k = up((rawK || "").trim());
      const v = Number((rawV || "").trim());
      if (k && Number.isFinite(v) && v > 0) out[k] = v;
    }
  }
  // Optional: remote JSON feed (simple key->number mapping)
  const feed = maybe("PRICE_FEED_URL");
  if (feed && Object.keys(out).length === 0) {
    try {
      const res = await fetch(feed, { headers: { "accept": "application/json" } });
      if (res.ok) {
        const j = await res.json();
        for (const [k, v] of Object.entries(j || {})) {
          const n = Number(v as any);
          if (Number.isFinite(n) && n > 0) out[up(k)] = n;
        }
      }
    } catch {
      // ignore
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
    const hours = Math.max(1, Number(url.searchParams.get("hours") || "24")); // window for mode=missing
    const days = Math.max(1, Number(url.searchParams.get("days") || "30"));  // window for mode=reprice
    const limit = Math.max(100, Math.min(5000, Number(url.searchParams.get("limit") || "2000"))); // per batch

    // Optional: filter po chainu (comma-separated), npr. chain=POL,ETH
    const chainFilter = (url.searchParams.get("chain") || "")
      .split(",")
      .map(s => up(s.trim()))
      .filter(Boolean);

    // Cijene
    const fx = await parseFxFromQuery(url);
    if (!fx || Object.keys(fx).length === 0) {
      // Bez cijena ne možemo izračunati amount_usd
      return NextResponse.json({ ok: false, error: "No FX map provided (use ?fx=POL:0.48,ETH:2400 or set PRICE_FEED_URL)" }, { status: 400 });
    }

    // Dohvati mapu wallet_id -> chain
    const { data: wallets, error: werr } = await client
      .from("wallets")
      .select("id, chain")
      .not("chain", "is", null);
    if (werr) throw new Error(`wallets: ${werr.message}`);

    const idToChain = new Map<string, string>();
    for (const w of wallets || []) {
      idToChain.set(w.id as string, up(w.chain as string));
    }

    // Datum granice
    const now = Date.now();
    const sinceTs = mode === "missing"
      ? new Date(now - hours * 3600_000).toISOString()
      : new Date(now - days * 86400_000).toISOString();

    // Selektor retka
    const baseSel = client
      .from("contributions")
      .select("id, wallet_id, amount, amount_usd, block_time")
      .gte("block_time", sinceTs)
      .order("block_time", { ascending: false })
      .limit(limit);

    // Za mode=missing filtriramo na amount_usd IS NULL
    let rowsResp = mode === "missing"
      ? await baseSel.is("amount_usd", null)
      : await baseSel;

    if (rowsResp.error) throw new Error(`select contributions: ${rowsResp.error.message}`);

    // (Opcionalni) filter po chainu
    let rows = (rowsResp.data || []).filter(r => idToChain.has(r.wallet_id as string));
    if (chainFilter.length) {
      rows = rows.filter(r => chainFilter.includes(up(idToChain.get(r.wallet_id as string))));
    }

    // Priprema update batch-a
    type UpRow = { id: number; amount_usd: number };
    const updates: UpRow[] = [];

    for (const r of rows) {
      const chain = up(idToChain.get(r.wallet_id as string));
      const price = fx[chain];
      if (!price) continue; // nema cijene za taj chain → preskačemo
      const amt = Number(r.amount);
      if (!Number.isFinite(amt)) continue;
      const usd = +(amt * price); // basic multiply, rounding prepusti DB formatu NUMERIC
      // kod mode=reprice uvijek upisujemo ponovno; kod missing upisujemo samo ako je null (već filtrirano)
      updates.push({ id: r.id as number, amount_usd: usd });
    }

    // Batch upsert preko PK id (samo kolona amount_usd)
    let updated = 0;
    const CHUNK = 500;
    for (let i = 0; i < updates.length; i += CHUNK) {
      const chunk = updates.slice(i, i + CHUNK);
      const { error: uerr } = await client
        .from("contributions")
        .upsert(
          chunk.map(u => ({ id: u.id, amount_usd: u.amount_usd })),
          { onConflict: "id" }
        );
      if (uerr) throw new Error(`upsert chunk failed: ${uerr.message}`);
      updated += chunk.length;
    }

    return NextResponse.json({
      ok: true,
      mode,
      since: sinceTs,
      considered: rows.length,
      updated,
      fxKeys: Object.keys(fx),
      chainFilter: chainFilter.length ? chainFilter : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

