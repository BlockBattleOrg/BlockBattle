// app/api/ingest/contrib/eth/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type Hex = `0x${string}`;

const ETH_RPC_URL = process.env.ETH_RPC_URL || "";
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY || "";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const CRON_SECRET = process.env.CRON_SECRET || "";

// skeniramo u manjim batch-evima, ali možemo po potrebi povećati
const BATCH_BLOCKS = 250;
const MAX_LOOKBACK = 5000;

function requireCron(req: Request) {
  const hdr = req.headers.get("x-cron-secret") || "";
  return CRON_SECRET && hdr === CRON_SECRET;
}

async function rpc<T>(method: string, params: any[]): Promise<T> {
  const res = await fetch(ETH_RPC_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": NOWNODES_API_KEY,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    // kratki timeout preko fetch race (Vercel edge nema native timeout ovdje)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`EVM RPC HTTP ${res.status} ${res.statusText}: ${txt.slice(0, 200)}`);
  }
  const json = (await res.json()) as { result?: T; error?: any };
  if (json.error) throw new Error(`RPC ${method} error: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

function hexToDec(hex: Hex): number {
  // blokovi su sigurni u JS Number
  return parseInt(hex.slice(2), 16);
}
function hexToEther(hex: Hex): number {
  // value u wei -> ETH, kao broj (za leaderboard u nativnim jedinicama)
  const wei = BigInt(hex);
  const ether = Number(wei) / 1e18; // može doći do preciznosti kod vrlo velikih vrijednosti, za donacije je ok
  return ether;
}

function normAddr(a?: string | null) {
  return String(a || "").trim().toLowerCase();
}

export async function POST(req: Request) {
  try {
    if (!requireCron(req)) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }
    if (!ETH_RPC_URL || !NOWNODES_API_KEY) {
      return NextResponse.json({ ok: false, error: "Missing ETH RPC env" }, { status: 500 });
    }
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return NextResponse.json({ ok: false, error: "Missing Supabase env" }, { status: 500 });
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // 1) aktivni ETH wallet-i (pokrivamo i slučaj bez currency_id)
    const { data: wallets, error: wErr } = await sb
      .from("wallets")
      .select(`id, address, chain, is_active, currencies ( symbol )`)
      .eq("is_active", true);
    if (wErr) throw wErr;

    const targets = new Map<string, string>(); // address -> wallet_id
    for (const w of wallets || []) {
      const sym = String((w as any)?.currencies?.symbol || "").toUpperCase();
      const chn = String((w as any)?.chain || "").toUpperCase();
      const isEth = sym === "ETH" || chn === "ETH" || chn === "ETHEREUM";
      if (!isEth) continue;
      const addr = normAddr((w as any).address);
      if (addr) targets.set(addr, (w as any).id);
    }
    if (targets.size === 0) {
      return NextResponse.json({ ok: false, error: "No active ETH wallet found" }, { status: 200 });
    }

    // 2) odredi raspon blokova
    const latestHex = await rpc<Hex>("eth_blockNumber", []);
    const latest = hexToDec(latestHex);

    // settings key
    const KEY = "eth_contrib_last_scanned";
    const { data: sRow } = await sb.from("settings").select("value").eq("key", KEY).maybeSingle();
    const prev = Number((sRow?.value as any)?.n ?? 0);

    let from = prev > 0 ? prev + 1 : Math.max(0, latest - MAX_LOOKBACK);
    // zaštita ako je previše staro
    if (latest - from > MAX_LOOKBACK) from = latest - MAX_LOOKBACK;

    const to = Math.min(latest, from + BATCH_BLOCKS - 1);

    if (to < from) {
      // nema što skenirati
      return NextResponse.json({ ok: true, latest, from, to, scanned: 0, inserted: 0 });
    }

    // 3) skeniraj blokove i sakupljaj pogodke
    const matches: { wallet_id: string; tx_hash: string; amount: number; block_time: string }[] = [];

    for (let b = from as number; b <= to; b++) {
      const blockHex = ("0x" + b.toString(16)) as Hex;
      const block = await rpc<any>("eth_getBlockByNumber", [blockHex, true]);
      const ts = Number(block?.timestamp ? parseInt(String(block.timestamp).slice(2), 16) : 0);
      const when = ts ? new Date(ts * 1000).toISOString() : new Date().toISOString();

      for (const tx of block?.transactions || []) {
        const toAddr = normAddr(tx?.to);
        if (!toAddr) continue; // npr. contract creation
        const walletId = targets.get(toAddr);
        if (!walletId) continue;

        const amt = hexToEther(tx?.value as Hex);
        if (amt <= 0) continue;

        matches.push({
          wallet_id: walletId,
          tx_hash: String(tx?.hash || ""),
          amount: amt,
          block_time: when,
        });
      }
    }

    // 4) deduplikacija prema postojećim tx_hash-evima
    let inserted = 0;
    if (matches.length > 0) {
      const hashes = Array.from(new Set(matches.map((m) => m.tx_hash)));
      const { data: existing } = await sb
        .from("contributions")
        .select("tx_hash")
        .in("tx_hash", hashes);
      const existingSet = new Set((existing || []).map((e: any) => String(e.tx_hash)));

      const toInsert = matches.filter((m) => !existingSet.has(m.tx_hash));

      if (toInsert.length > 0) {
        const { error: insErr } = await sb.from("contributions").insert(
          toInsert.map((m) => ({
            wallet_id: m.wallet_id,
            tx_hash: m.tx_hash,
            amount: m.amount,
            block_time: m.block_time,
            // amount_usd: null (opcionalno kasnije)
          }))
        );
        if (insErr) throw insErr;
        inserted = toInsert.length;
      }
    }

    // 5) spremi napredak
    await sb
      .from("settings")
      .upsert({ key: KEY, value: { n: to } }, { onConflict: "key" })
      .select()
      .single();

    return NextResponse.json({
      ok: true,
      latest,
      from,
      to,
      scanned: to - from + 1,
      inserted,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "ETH ingest error" }, { status: 500 });
  }
}

