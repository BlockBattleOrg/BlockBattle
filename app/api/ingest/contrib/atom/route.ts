// app/api/ingest/contrib/atom/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

/**
 * ATOM (Cosmos Hub) contributions ingest (NowNodes LCD-compatible).
 *
 * Strategy (low-risk, rate-limit friendly):
 * - For each active ATOM wallet, fetch up to N pages of txs where the wallet is the recipient.
 * - Parse MsgSend (and MultiSend outputs) addressed to our wallet.
 * - Insert one contribution per tx hash (per wallet) if not already present.
 *
 * LCD compatibility:
 *  - Uses /cosmos/tx/v1beta1/txs?events=transfer.recipient='addr'
 *  - Paginates with pagination.next_key
 *
 * ENV expected:
 *  - SUPABASE_URL
 *  - SUPABASE_SERVICE_ROLE_KEY
 *  - NOWNODES_API_KEY
 *  - ATOM_LCD_URL or ATOM_REST_URL or COSMOS_LCD_URL   (e.g. https://cosmos.nownodes.io)
 *  - CRON_SECRET (header: x-cron-secret)
 */

type WalletRow = {
  id: string;
  address: string;
  chain: string; // 'atom'
  is_active: boolean;
  currencies?: { decimals?: number; symbol?: string }[];
};

const LCD_BASE =
  (process.env.ATOM_LCD_URL || process.env.ATOM_REST_URL || process.env.COSMOS_LCD_URL || "").trim();
const API_KEY = (process.env.NOWNODES_API_KEY || "").trim();

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim();
const SUPABASE_SERVICE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();

const CRON_SECRET = (process.env.CRON_SECRET || "").trim();

const PAGE_LIMIT = 50;       // txs per page
const MAX_PAGES_PER_WAL = 3; // safety to avoid excessive scans (tune later)
const HTTP_TIMEOUT_MS = 15000;

function jsonError(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

async function lcd(path: string, qs?: Record<string, string | number | undefined | null>) {
  if (!LCD_BASE) throw new Error("Missing ATOM LCD base URL env (ATOM_LCD_URL | ATOM_REST_URL | COSMOS_LCD_URL)");
  const u = new URL(path.replace(/^\/+/, ""), LCD_BASE.endsWith("/") ? LCD_BASE : LCD_BASE + "/");
  if (qs) {
    for (const [k, v] of Object.entries(qs)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
  }
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json",
        "api-key": API_KEY || "",       // NowNodes header
      },
      signal: ctrl.signal,
      // Note: NowNodes ponekad traži i project_id (Blockfrost stil); ovdje nije potrebno za Cosmos LCD
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} ${text.slice(0, 400)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

async function getActiveAtomWallets(supabase: ReturnType<typeof createClient>): Promise<WalletRow[]> {
  // wallets.chain je lowercase ('atom'); join na currencies za decimals
  const { data, error } = await supabase
    .from("wallets")
    .select("id,address,chain,is_active,currencies(decimals,symbol)")
    .eq("chain", "atom");

  if (error) throw error;
  return (data || []).filter(w => w.is_active);
}

type TxResponse = {
  txhash: string;
  height: string;      // number as string
  timestamp: string;   // RFC3339
};

type TxBodyMsg = {
  "@type": string;
  from_address?: string;
  to_address?: string;
  amount?: { denom: string; amount: string }[];
  inputs?: { address: string; coins: { denom: string; amount: string }[] }[];   // for MsgMultiSend
  outputs?: { address: string; coins: { denom: string; amount: string }[] }[];  // for MsgMultiSend
};

type Tx = {
  body?: { messages?: TxBodyMsg[] };
};

type TxsSearchResp = {
  txs?: Tx[];
  tx_responses?: TxResponse[];
  pagination?: { next_key?: string | null };
};

function sumCoinsToAddr(msgs: TxBodyMsg[] | undefined, ourAddr: string, atomDenom = "uatom"): bigint {
  if (!msgs?.length) return 0n;
  let total = 0n;

  for (const m of msgs) {
    const t = m["@type"] || "";

    // /cosmos.bank.v1beta1.MsgSend
    if (t.endsWith("MsgSend")) {
      if (m.to_address && m.to_address === ourAddr && Array.isArray(m.amount)) {
        for (const c of m.amount) {
          if ((c.denom || "") === atomDenom) {
            const n = BigInt(c.amount || "0");
            total += n;
          }
        }
      }
    }

    // /cosmos.bank.v1beta1.MsgMultiSend
    if (t.endsWith("MsgMultiSend")) {
      if (Array.isArray(m.outputs)) {
        for (const out of m.outputs) {
          if (out.address === ourAddr) {
            for (const c of out.coins || []) {
              if ((c.denom || "") === atomDenom) {
                total += BigInt(c.amount || "0");
              }
            }
          }
        }
      }
    }
  }

  return total;
}

async function insertIfNotExists(
  supabase: ReturnType<typeof createClient>,
  wallet_id: string,
  tx_hash: string,
  amount_tokens: number,
  block_time_iso: string
): Promise<boolean> {
  // Provjeri postoji li već zapis za (wallet_id, tx_hash)
  const { data: existsRows, error: existsErr } = await supabase
    .from("contributions")
    .select("id")
    .eq("wallet_id", wallet_id)
    .eq("tx_hash", tx_hash)
    .limit(1);

  if (existsErr) throw existsErr;
  if (existsRows && existsRows.length > 0) return false;

  const { error: insErr } = await supabase
    .from("contributions")
    .insert({
      wallet_id,
      tx_hash,
      amount: amount_tokens,  // stored in whole tokens (ATOM), decimals handled below
      block_time: block_time_iso,
    });

  if (insErr) throw insErr;
  return true;
}

export async function POST(req: Request) {
  try {
    // Auth via cron secret
    const headerSecret = (req.headers.get("x-cron-secret") || "").trim();
    if (CRON_SECRET && headerSecret !== CRON_SECRET) {
      return jsonError(401, "Unauthorized (bad cron secret)");
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return jsonError(500, "Missing Supabase env");
    }
    if (!LCD_BASE) {
      return jsonError(500, "Missing ATOM LCD base URL env (ATOM_LCD_URL | ATOM_REST_URL | COSMOS_LCD_URL)");
    }
    if (!API_KEY) {
      return jsonError(500, "Missing NOWNODES_API_KEY");
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1) Učitaj aktivne ATOM wallete
    const wallets = await getActiveAtomWallets(supabase);
    if (!wallets.length) {
      return NextResponse.json({ ok: true, scanned_wallets: 0, inserted: 0, note: "No active ATOM wallets." });
    }

    // 2) Za svaki wallet povuci do MAX_PAGES_PER_WAL stranica recent tx-ova gdje je recipient
    let totalScanned = 0;
    let totalInserted = 0;
    const perWallet: Record<string, { scanned: number; inserted: number }> = {};

    for (const w of wallets) {
      const walletId = w.id;
      const addr = (w.address || "").trim();
      const decimals = Number(w.currencies?.[0]?.decimals ?? 6); // Cosmos Hub: 6
      const denom = "uatom";

      if (!addr) continue;
      perWallet[addr] = { scanned: 0, inserted: 0 };

      let page = 0;
      let next_key: string | null | undefined = undefined;

      while (page < MAX_PAGES_PER_WAL) {
        const qs: Record<string, string> = {
          "events": `transfer.recipient='${addr}'`,
          "orderBy": "ORDER_BY_DESC",
          "limit": String(PAGE_LIMIT),
        };
        if (next_key) qs["pagination.key"] = next_key;

        let resp: TxsSearchResp;
        try {
          resp = await lcd("/cosmos/tx/v1beta1/txs", qs);
        } catch (e: any) {
          return jsonError(502, `ATOM LCD error: ${String(e?.message || e)}`);
        }
        const txs = resp.txs || [];
        const txr = resp.tx_responses || [];

        if (!txs.length || !txr.length) break;

        for (let i = 0; i < Math.min(txs.length, txr.length); i++) {
          const tx = txs[i];
          const tr = txr[i];
          perWallet[addr].scanned++;
          totalScanned++;

          const msgs = tx?.body?.messages || [];
          const sumU = sumCoinsToAddr(msgs, addr, denom);
          if (sumU <= 0n) continue;

          const amountTokens = Number(sumU) / Math.pow(10, decimals);
          const inserted = await insertIfNotExists(supabase, walletId, tr.txhash, amountTokens, tr.timestamp);
          if (inserted) {
            perWallet[addr].inserted++;
            totalInserted++;
          }
        }

        next_key = resp.pagination?.next_key;
        if (!next_key) break;
        page++;
      }
    }

    return NextResponse.json({
      ok: true,
      scanned_wallets: wallets.length,
      scanned: totalScanned,
      inserted: totalInserted,
      per_wallet: perWallet,
    });

  } catch (e: any) {
    return jsonError(500, `ATOM ingest failed: ${String(e?.message || e)}`);
  }
}

