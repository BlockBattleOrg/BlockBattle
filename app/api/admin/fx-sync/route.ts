// app/api/admin/fx-sync/route.ts
import { NextResponse } from "next/server";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { canonChain, Canon } from "@/lib/chain";

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

function supa(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) throw new Error("Missing Supabase ENV for fx-sync");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function parseFxFromQuery(url: URL): Promise<FXMap> {
  const fxParam = url.searchParams.get("fx") || "";
  const out: FXMap = {};

  // 1) explicit fx=POL:0.51,ETH:2400,BNB:520 ...
  if (fxParam) {
    for (const part of fxParam.split(",")) {
      const [k0, v0] = part.split(":");
      const c = canonChain(k0);
      const n = Number((v0 || "").trim());
      if (c && Number.isFinite(n) && n > 0) out[c] = n;
    }
  }

  // 2) optional price feed JSON { "POL": 0.51, "ETH": 2400, ... }
  if (Object.keys(out).length === 0) {
    const feed = maybe("PRICE_FEED_URL");
    if (feed) {
      try {
        const res = await fetch(feed, { headers: { accept: "application/json" } });
        if (res.ok) {
          const j = (await res.json()) as Record<string, unknown>;
          for (const [k, v] of Object.entries(j || {})) {
            const c = canonChain(k);
            const n = Number(v as any);
            if (c && Number.isFinite(n) && n > 0) out[c] = n;
          }
        }
      } catch {
        // ignore feed errors; caller can still provide ?fx=
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

    const mode = (url.searchParams.get("mode") || "missing").toLowerCase(); // "missing" | "reprice"
    const hours = Math.max(1, Number(url.searchParams.get("hours") || "24"));
    const days = Math.max(1, Number(url.searchParams.get("days") || "30"));
    const limit = Math.max(100, Math.min(5000, Number(url.searchParams.get("limit") || "2000")));

    // chain=POL,BNB,SOL,... (optional)
    const chainFilterRaw = (url.searchParams.get("chain") || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);

    // ✅ FIX: type predicate narrows to Canon
    const chainFilter = chainFilterRaw
      .map(canonChain)
      .filter((x): x is Canon => Boolean(x));

    const fx = await parseFxFromQuery(url);
    if (!fx || Object.keys(fx).length === 0) {
      return NextResponse.json(
        { ok: false, error: "No FX map provided (?fx=POL:0.51,ETH:2400,BNB:520 or PRICE_FEED_URL)" },
        { status: 400 }
      );
    }

    // wallets → map wallet_id -> Canon chain
    const { data: wallets, error: werr } = await client
      .from("wallets")
      .select("id, chain");
    if (werr) throw new Error(`wallets: ${werr.message}`);

    const idToChain = new Map<string, Canon>();
    for (const w of wallets || []) {
      const c = canonChain((w as any).chain);
      if (c) idToChain.set(String((w as any).id), c);
    }

    // time window
    const now = Date.now();
    const sinceIso = mode === "missing"
      ? new Date(now - hours * 3600_000).toISOString()
      : new Date(now - days  * 86400_000).toISOString();

    // select contributions in window (missing mode filters by amount_usd is null)
    let sel = client
      .from("contributions")
      .select("id, wallet_id, amount, amount_usd, block_time")
      .gte("block_time", sinceIso)
      .order("block_time", { ascending: false })
      .limit(limit);

    if (mode === "missing") sel = sel.is("amount_usd", null);

    const { data: rows, error: rerr } = await sel;
    if (rerr) throw new Error(`select contributions: ${rerr.message}`);

    const pool = (rows || []).filter(r => {
      const wid = (r as any).wallet_id ? String((r as any).wallet_id) : "";
      const cid = wid ? idToChain.get(wid) : undefined;
      if (!cid) return false;
      if (chainFilter.length) return chainFilter.includes(cid);
      return true;
    });

    let considered = 0;
    let updated = 0;

    for (const r of pool) {
      considered++;
      const wid = String((r as any).wallet_id);
      const chainCanon = idToChain.get(wid)!;
      const price = fx[chainCanon]; // fx keys are Canon strings
      if (!price) continue;

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
      fxKeys: Object.keys(fx),
      chainFilter: chainFilter.length ? chainFilter : undefined,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}

