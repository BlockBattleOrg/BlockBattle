// app/api/ingest/contrib/btc/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const API_BASE = (process.env.BTC_API_BASE || "").replace(/\/+$/,""); // e.g. https://blockstream.info/api
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

const MAX_PAGES = Number(process.env.BTC_MAX_PAGES || 2); // each page = 25 tx
const PAGE_SIZE = 25;

type TxOut = { scriptpubkey_address?: string; value: number };
type Tx = {
  txid: string;
  vout: TxOut[];
  status?: { block_time?: number };
};

function isBTC(symbol?: string | null, chain?: string | null) {
  const s = String(symbol || "").trim().toUpperCase();
  const c = String(chain || "").trim().toUpperCase();
  return s === "BTC" || c === "BTC" || c === "BITCOIN";
}

async function getAddressTxs(addr: string, lastSeen?: string | null, pages = MAX_PAGES): Promise<Tx[]> {
  // Blockstream: /address/:addr/txs  (newest first)
  // Pagination: /address/:addr/txs/chain/:last_txid (older)
  const all: Tx[] = [];
  let url = `${API_BASE}/address/${addr}/txs`;
  let loops = 0;
  while (loops < pages) {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) {
      const t = await res.text().catch(()=> "");
      throw new Error(`BTC API ${res.status} ${res.statusText}${t ? `: ${t}` : ""}`);
    }
    const page = (await res.json()) as Tx[];
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    // next page url:
    const last = page[page.length - 1]?.txid;
    if (!last) break;
    url = `${API_BASE}/address/${addr}/txs/chain/${last}`;
    loops++;
  }
  return all;
}

function satsToBtc(sats: number) {
  return sats / 1e8;
}

export async function POST(req: Request) {
  try {
    if (!CRON_SECRET || (req.headers.get("x-cron-secret") || "") !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    if (!API_BASE) {
      return NextResponse.json({ ok: false, error: "Missing BTC_API_BASE" }, { status: 500 });
    }
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) BTC wallets (active)
    const { data: walletsAll, error: wErr } = await sb
      .from("wallets")
      .select(`
        id, address, chain, is_active, currency_id,
        currencies:currency_id ( symbol )
      `)
      .eq("is_active", true);

    if (wErr) throw wErr;

    const wallets = (walletsAll || []).filter((w: any) => w?.address && isBTC(w?.currencies?.symbol, w?.chain));
    if (wallets.length === 0) {
      return NextResponse.json({ ok: true, info: "No BTC wallets active; nothing to ingest.", inserted: 0 });
    }

    // 2) fetch txs per address
    const toInsert: { wallet_id: string; tx_hash: string; amount: number; block_time: string }[] = [];

    for (const w of wallets) {
      const addr = String((w as any).address).trim();
      if (!addr) continue;

      const txs = await getAddressTxs(addr, null, MAX_PAGES);

      for (const tx of txs) {
        // sum every vout that pays to THIS address
        const sats = (tx.vout || [])
          .filter((o) => (o?.scriptpubkey_address || "").toLowerCase() === addr.toLowerCase())
          .reduce((acc, o) => acc + Number(o?.value || 0), 0);

        if (sats <= 0) continue;

        const whenSec = Number(tx?.status?.block_time || 0);
        const whenIso = whenSec > 0 ? new Date(whenSec * 1000).toISOString() : new Date().toISOString();

        toInsert.push({
          wallet_id: (w as any).id,
          tx_hash: tx.txid,
          amount: satsToBtc(sats),
          block_time: whenIso,
        });
      }
    }

    // 3) de-dup by tx_hash (global) — NOTE: ako isti tx plaća na više naših adresa, drugi ulaz će biti preskočen
    const hashes = Array.from(new Set(toInsert.map((r) => r.tx_hash)));
    let existing = new Set<string>();
    if (hashes.length) {
      const { data: ex } = await sb.from("contributions").select("tx_hash").in("tx_hash", hashes);
      existing = new Set((ex || []).map((e: any) => String(e.tx_hash)));
    }
    const rows = toInsert.filter((r) => !existing.has(r.tx_hash));

    if (rows.length) {
      const { error: insErr } = await sb.from("contributions").insert(rows);
      if (insErr) throw insErr;
    }

    return NextResponse.json({
      ok: true,
      chain: "BTC",
      scanned_wallets: wallets.length,
      candidates: toInsert.length,
      inserted: rows.length,
      pages_per_wallet: MAX_PAGES,
      page_size: PAGE_SIZE,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "BTC contrib ingest failed" }, { status: 500 });
  }
}

