// app/api/ingest/contrib/ltc/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const RPC = (process.env.LTC_RPC_URL || "").trim();
const KEY = (process.env.NOWNODES_API_KEY || "").trim();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

const SPAN = Number(process.env.LTC_CONTRIB_SPAN || 50); // broj blokova po run-u

type Json = any;

type Vout = {
  value?: number; // in LTC
  scriptPubKey?: {
    address?: string;      // single
    addresses?: string[];  // array
  };
};

type VerboseTx = {
  txid: string;
  vout?: Vout[];
};

type VerboseBlock = {
  height: number;
  time?: number;          // unix seconds
  tx?: VerboseTx[];
};

async function rpc<T = Json>(method: string, params: any[]): Promise<T> {
  if (!RPC) throw new Error("Missing LTC_RPC_URL");
  if (!KEY) throw new Error("Missing NOWNODES_API_KEY");
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": KEY },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`LTC RPC HTTP ${res.status} ${res.statusText}${txt ? `: ${txt}` : ""}`);
  }
  const json = (await res.json()) as any;
  if (json.error) throw new Error(String(json.error?.message || "RPC error"));
  return json.result as T;
}

function isLTC(symbol?: string | null, chain?: string | null) {
  const s = String(symbol || "").trim().toUpperCase();
  const c = String(chain || "").trim().toUpperCase();
  return s === "LTC" || c === "LTC" || c === "LITECOIN";
}

function relFirst<T = any>(maybe: any): T | undefined {
  if (!maybe) return undefined;
  return Array.isArray(maybe) ? maybe[0] : maybe;
}

export async function POST(req: Request) {
  try {
    // auth
    if (!CRON_SECRET || (req.headers.get("x-cron-secret") || "") !== CRON_SECRET) {
      return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
    }
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) Učitaj aktivne LTC novčanike
    const { data: walletsAll, error: wErr } = await sb
      .from("wallets")
      .select(`
        id, address, chain, is_active, currency_id,
        currencies:currency_id ( symbol )
      `)
      .eq("is_active", true);
    if (wErr) throw wErr;

    const wallets = (walletsAll || []).filter((w: any) => w?.address && isLTC(w?.currencies?.symbol, w?.chain));
    if (wallets.length === 0) {
      return NextResponse.json({ ok: true, info: "No LTC wallets active; nothing to ingest.", inserted: 0 });
    }

    // mapiraj adrese → wallet_id (NAPOMENA: ne mijenjamo velika/mala slova; base58 je case-sensitive)
    const addrToWallet = new Map<string, string>();
    for (const w of wallets) {
      addrToWallet.set(String((w as any).address).trim(), (w as any).id);
    }

    // 2) Odredi raspon blokova za skeniranje
    const latest = await rpc<number>("getblockcount", []);
    const keyMarker = "ltc_contrib_last_scanned";

    const { data: sRow } = await sb.from("settings").select("value").eq("key", keyMarker).maybeSingle();
    const last = Number((sRow as any)?.value?.n ?? NaN);

    const startBase = Number.isFinite(last) ? last : Math.max(0, latest - SPAN);
    const from = Math.max(0, startBase + 1);
    const to = Math.min(latest, from + SPAN - 1);
    const scanned = to >= from ? to - from + 1 : 0;

    // 3) Skeniraj blokove i pronađi uplate na naše adrese
    // skupljamo po ključu (txid + wallet_id) kako bismo sumirali više vout-ova iz istog tx na isti wallet
    const agg = new Map<string, { wallet_id: string; tx_hash: string; amount: number; block_time: string }>();

    for (let h = from; h <= to; h++) {
      const hash = await rpc<string>("getblockhash", [h]);
      const blk = await rpc<VerboseBlock>("getblock", [hash, 2]); // verbosity=2 (decoded tx)
      const tsIso = new Date(((blk?.time || 0) * 1000) || Date.now()).toISOString();

      for (const tx of blk?.tx || []) {
        const txid = tx.txid;
        for (const v of tx.vout || []) {
          const addrs: string[] = [];
          const spk = v.scriptPubKey || {};
          if (spk.address) addrs.push(String(spk.address).trim());
          if (Array.isArray(spk.addresses)) {
            for (const a of spk.addresses) addrs.push(String(a).trim());
          }
          if (addrs.length === 0) continue;

          for (const a of addrs) {
            const walletId = addrToWallet.get(a);
            if (!walletId) continue;

            const key = `${txid}:${walletId}`;
            const prev = agg.get(key);
            const add = Number(v.value || 0); // value je već u LTC
            if (!add) continue;

            if (prev) {
              prev.amount += add;
            } else {
              agg.set(key, { wallet_id: walletId, tx_hash: txid, amount: add, block_time: tsIso });
            }
          }
        }
      }
    }

    const candidates = Array.from(agg.values());

    // 4) De-dup: provjeri postoje li već (po (tx_hash, wallet_id))
    let existingKeys = new Set<string>();
    if (candidates.length) {
      const { data: ex } = await sb
        .from("contributions")
        .select("tx_hash, wallet_id")
        .in("tx_hash", Array.from(new Set(candidates.map((r) => r.tx_hash))));
      existingKeys = new Set((ex || []).map((e: any) => `${e.tx_hash}:${e.wallet_id}`));
    }

    const rows = candidates.filter((r) => !existingKeys.has(`${r.tx_hash}:${r.wallet_id}`));

    if (rows.length) {
      const { error: insErr } = await sb.from("contributions").insert(rows);
      if (insErr) throw insErr;
    }

    // 5) Pomakni marker
    await sb.from("settings").upsert({ key: keyMarker, value: { n: to } }, { onConflict: "key" });

    return NextResponse.json({
      ok: true,
      chain: "LTC",
      latest,
      from,
      to,
      scanned,
      found: candidates.length,
      inserted: rows.length,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "LTC contrib ingest failed" }, { status: 500 });
  }
}

