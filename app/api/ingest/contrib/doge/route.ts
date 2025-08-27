// app/api/ingest/contrib/doge/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

const RPC = (process.env.DOGE_RPC_URL || "").trim();
const KEY = (process.env.NOWNODES_API_KEY || "").trim();
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

const SPAN = Number(process.env.DOGE_CONTRIB_SPAN || 50); // blocks per run

type Json = any;

type Vout = {
  value?: number; // in DOGE
  scriptPubKey?: {
    address?: string;
    addresses?: string[];
  };
};

type VerboseTx = {
  txid: string;
  vout?: Vout[];
};

type VerboseBlock = {
  height?: number;
  time?: number; // unix seconds
  tx?: (VerboseTx | string)[];
};

async function rpc<T = Json>(method: string, params: any[]): Promise<T> {
  if (!RPC) throw new Error("Missing DOGE_RPC_URL");
  if (!KEY) throw new Error("Missing NOWNODES_API_KEY");
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": KEY },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`DOGE RPC HTTP ${res.status} ${res.statusText}${txt ? `: ${txt}` : ""}`);
  }
  const json = (await res.json()) as any;
  if (json.error) throw new Error(String(json.error?.message || "RPC error"));
  return json.result as T;
}

function isDOGE(symbol?: string | null, chain?: string | null) {
  const s = String(symbol || "").trim().toUpperCase();
  const c = String(chain || "").trim().toUpperCase();
  return s === "DOGE" || c === "DOGE" || c === "DOGECOIN";
}

function relFirst<T = any>(maybe: any): T | undefined {
  if (!maybe) return undefined;
  return Array.isArray(maybe) ? maybe[0] : maybe;
}

// Load block with transactions (prefer verbosity=2; fallback to 1 + getrawtransaction)
async function loadBlockVerbose(height: number): Promise<{ timeISO: string; txs: VerboseTx[] }> {
  const hash = await rpc<string>("getblockhash", [height]);

  // Try verbosity=2 (decoded transactions included)
  try {
    const blk = await rpc<VerboseBlock>("getblock", [hash, 2]);
    const tsIso = new Date(((blk?.time || 0) * 1000) || Date.now()).toISOString();

    if (Array.isArray(blk?.tx) && typeof blk.tx[0] === "object") {
      return { timeISO: tsIso, txs: blk.tx as VerboseTx[] };
    }
  } catch {
    // fall through
  }

  // Fallback: verbosity=1 → list of txids; fetch each via getrawtransaction
  const blk1 = await rpc<VerboseBlock>("getblock", [hash, 1]);
  const tsIso = new Date(((blk1?.time || 0) * 1000) || Date.now()).toISOString();
  const txids: string[] = (blk1?.tx || []).map((t: any) => String(t));

  const txs: VerboseTx[] = [];
  for (const id of txids) {
    try {
      const vtx = await rpc<VerboseTx>("getrawtransaction", [id, true]);
      txs.push(vtx);
    } catch {
      // skip a tx on failure
    }
  }
  return { timeISO: tsIso, txs };
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

    // 1) Active DOGE wallets
    const { data: walletsAll, error: wErr } = await sb
      .from("wallets")
      .select(`
        id, address, chain, is_active, currency_id,
        currencies:currency_id ( symbol )
      `)
      .eq("is_active", true);
    if (wErr) throw wErr;

    const wallets = (walletsAll || []).filter((w: any) => w?.address && isDOGE(w?.currencies?.symbol, w?.chain));
    if (wallets.length === 0) {
      return NextResponse.json({ ok: true, info: "No DOGE wallets active; nothing to ingest.", inserted: 0 });
    }

    // Map addresses → wallet_id (Base58: keep exact case)
    const addrToWallet = new Map<string, string>();
    for (const w of wallets) {
      addrToWallet.set(String((w as any).address).trim(), (w as any).id);
    }

    // 2) Height range
    const latest = await rpc<number>("getblockcount", []);
    const KEY_MARKER = "doge_contrib_last_scanned";
    const { data: sRow } = await sb.from("settings").select("value").eq("key", KEY_MARKER).maybeSingle();
    const last = Number((sRow as any)?.value?.n ?? NaN);

    const startBase = Number.isFinite(last) ? last : Math.max(0, latest - SPAN);
    const from = Math.max(0, startBase + 1);
    const to = Math.min(latest, from + SPAN - 1);
    const scanned = to >= from ? to - from + 1 : 0;

    // 3) Scan blocks → collect outputs to our addresses
    const agg = new Map<string, { wallet_id: string; tx_hash: string; amount: number; block_time: string }>();

    for (let h = from; h <= to; h++) {
      const { timeISO, txs } = await loadBlockVerbose(h);

      for (const tx of txs || []) {
        const txid = tx?.txid;
        if (!txid) continue;

        for (const v of tx?.vout || []) {
          const spk = v?.scriptPubKey || {};
          const addrs: string[] = [];
          if (spk.address) addrs.push(String(spk.address).trim());
          if (Array.isArray(spk.addresses)) {
            for (const a of spk.addresses) addrs.push(String(a).trim());
          }
          if (!addrs.length) continue;

          for (const a of addrs) {
            const walletId = addrToWallet.get(a);
            if (!walletId) continue;

            const key = `${txid}:${walletId}`;
            const add = Number(v?.value || 0); // 'value' is already DOGE
            if (!add) continue;

            const prev = agg.get(key);
            if (prev) prev.amount += add;
            else agg.set(key, { wallet_id: walletId, tx_hash: txid, amount: add, block_time: timeISO });
          }
        }
      }
    }

    const candidates = Array.from(agg.values());

    // 4) De-dup by (tx_hash, wallet_id)
    let existingKeys = new Set<string>();
    if (candidates.length) {
      const uniqHashes = Array.from(new Set(candidates.map((r) => r.tx_hash)));
      const { data: ex } = await sb
        .from("contributions")
        .select("tx_hash, wallet_id")
        .in("tx_hash", uniqHashes);
      existingKeys = new Set((ex || []).map((e: any) => `${e.tx_hash}:${e.wallet_id}`));
    }

    const rows = candidates.filter((r) => !existingKeys.has(`${r.tx_hash}:${r.wallet_id}`));

    if (rows.length) {
      const { error: insErr } = await sb.from("contributions").insert(rows);
      if (insErr) throw insErr;
    }

    // 5) Advance marker
    await sb.from("settings").upsert({ key: KEY_MARKER, value: { n: to } }, { onConflict: "key" });

    return NextResponse.json({
      ok: true,
      chain: "DOGE",
      latest,
      from,
      to,
      scanned,
      found: candidates.length,
      inserted: rows.length,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "DOGE contrib ingest failed" }, { status: 500 });
  }
}

