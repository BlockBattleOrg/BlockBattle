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
const up = (x?: string | null) => String(x || "").toUpperCase();

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
      const [k0, v0] = part.split(":");
      const k = up((k0 || "").trim());
      const v = Number((v0 || "").trim());
      if (k && Number.isFinite(v) && v > 0) out[k] = v;
    }
  }
  // optional remote feed
  if (Object.keys(out).length === 0) {
    const feed = maybe("PRICE_FEED_URL");
    if (feed) {
      try {
        const res = await fetch(feed, { headers: { accept: "application/json" } });
        if (res.ok) {
          const j = await res.json();
          for (const [k, v] of Object.entries(j || {})) {
            const n = Number(v as any);
            if (Number.isFinite(n) && n > 0) out[up(k)] = n;
          }
        }
      } catch {}
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
    const mode = (url.searchParams.get("mode") || "missing").toLowerCase(); // missing | reprice
    const hours = Math.max(1, Number(url.searchParams.get("hours") || "24")); // for missing
    const days = Math.max(1, Number(url.searchParams.get("days") || "30"));  // for reprice
    const limit = Math.max(100, Math.min(5000, Number(url.searchParams.get("limit") || "2000")));
    const chainFilter = (url.searchParams.get("chain") || "")
      .split(",")
      .map(s => up(s.trim()))
      .filter(Boolean);

    const fx = await parseFxFromQuery(url);
    if (!fx || Object.keys(fx).length === 0) {
      return NextResponse.json({ ok: false, error: "No FX map provided (?fx=POL:0.51,ETH:2400 or PRICE_FEED_URL)" }, { status: 400 });
    }

    // wallets -> map id -> CHAIN
    const { data: wallets, error: werr } = await client
      .from("wallets")
      .select("id, chain")
      .not("chain", "is", null);
    if (werr) throw new Error(`wallets: ${werr.message}`);

    const idToChain = new Map<string, string>();
    for (const w of wallets || []) idToChain.set(String(w.id), up(String(w.chain)));

    const now = Date.now();
    const sinceIso = mode === "missing"
      ? new Date(now - hours * 3600_000).toISOString()
      : new Date(now - days * 86400_000).toISOString();

    // base select
    let q = client
      .from("contributions")
      .select("id, wallet_id, amount, amount_usd, block_time")
      .gte("block_time", sinceIso)
      .order("block_time", { ascending: false })
      .limit(limit);

    if (mode === "missing") q = q.is("amount_usd", null);

    const { data: rows, error: rerr } = await q;
    if (rerr) throw new Error(`select contributions: ${rerr.message}`);

    // filter po chainu (ako tražen)
    const filtered = (rows || []).filter(r => r.wallet_id && idToChain.has(String(r.wallet_id)));
    const pool = chainFilter.length
      ? filtered.filter(r => chainFilter.includes(idToChain.get(String(r.wallet_id))!))
      : filtered;

    // priprema per-row update (bez upsert!)
    let considered = 0;
    let updated = 0;

    for (const r of pool) {
      considered++;
      const chain = idToChain.get(String(r.wallet_id))!;
      const price = fx[chain];
      if (!price) continue;

      const amt = Number(r.amount);
      if (!Number.isFinite(amt)) continue;

      const usd = amt * price;

      const { error: uerr } = await client
        .from("contributions")
        .update({ amount_usd: usd })
        .eq("id", r.id as number);
      if (uerr) throw new Error(`update id=${r.id}: ${uerr.message}`);
      updated++;
    }

    return NextResponse.json({
      ok: true,
      mode,
      since: sinceIso,
      considered,
      updated,
      fxKeys: Object.keys(fx),
      chainFilter: chainFilter.length ? chainFilter : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

