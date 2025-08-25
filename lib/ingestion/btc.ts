// lib/ingestion/btc.ts
import { getSupabaseAdmin } from "../supabaseAdmin";
import { fetchIncomingForAddress, BtcTx } from "../providers/btc/blockstream";

/**
 * Wallet row as per your schema (Phase 2 + is_active).
 */
type Wallet = {
  id: string;
  currency_id: string | null;
  address: string;
  chain: string;
  is_active?: boolean | null;
};

const BTC_DECIMALS = 8;

// In-run USD rate cache to minimize DB reads for the same day.
const usdCache = new Map<string, number | null>();

/**
 * Read active BTC wallets based on `chain = 'bitcoin'` and `is_active = true`.
 * This avoids depending on the presence of a BTC row in `currencies`.
 */
async function getActiveBtcWallets(): Promise<Wallet[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("wallets")
    .select("id, currency_id, address, chain, is_active")
    .eq("chain", "bitcoin")
    .eq("is_active", true);

  if (error) throw error;
  return data ?? [];
}

/**
 * Convert satoshis -> BTC using decimals from schema (BTC uses 8).
 */
function toAmountBTC(satoshis: number, decimals = BTC_DECIMALS): number {
  return Number((satoshis / Math.pow(10, decimals)).toFixed(decimals));
}

/**
 * Optional: read USD rate for BTC for a given day from `settings` table.
 * If you don't have this table/row yet, this will simply return null
 * and we will insert `amount_usd = null`.
 *
 * Expected key convention (example): key = `fx:BTC:YYYY-MM-DD`, value = { usd: number }
 */
async function getUsdRateFor(dateISO: string): Promise<number | null> {
  const supabase = getSupabaseAdmin();
  const day = dateISO.slice(0, 10); // YYYY-MM-DD
  if (usdCache.has(day)) return usdCache.get(day)!;

  const key = `fx:BTC:${day}`;
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("key", key)
    .single();

  if (error || !data) {
    usdCache.set(day, null);
    return null;
  }
  const usd = data?.value?.usd;
  const rate = typeof usd === "number" ? usd : null;
  usdCache.set(day, rate);
  return rate;
}

/**
 * Insert rows into `contributions` per your schema:
 * columns: wallet_id, tx_hash, amount, amount_usd, block_time
 * unique: (wallet_id, tx_hash)
 */
async function upsertContributions(rows: {
  wallet_id: string;
  tx_hash: string;
  amount: number;
  amount_usd: number | null;
  block_time: string; // ISO timestamp
}[]) {
  if (!rows.length) return;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("contributions")
    .upsert(rows, { onConflict: "wallet_id,tx_hash" });
  if (error) throw error;
}

/**
 * Fetch incoming BTC txs for a wallet, map to schema, and upsert.
 */
async function ingestForWallet(wallet: Wallet) {
  const incoming: BtcTx[] = await fetchIncomingForAddress(wallet.address);
  if (!incoming.length) return;

  const rows = [];
  for (const tx of incoming) {
    const amount = toAmountBTC(tx.satoshis, BTC_DECIMALS);
    const usdRate = await getUsdRateFor(tx.timestamp); // tx.timestamp = ISO string
    rows.push({
      wallet_id: wallet.id,
      tx_hash: tx.txid,
      amount,
      amount_usd: usdRate ? Number((amount * usdRate).toFixed(2)) : null,
      block_time: tx.timestamp,
    });
  }
  await upsertContributions(rows);
}

/**
 * Public entrypoint called by the API route.
 */
export async function runBtcIngestion(): Promise<{ ok: true; wallets: number; processed: number }> {
  const wallets = await getActiveBtcWallets();
  let processed = 0;

  for (const w of wallets) {
    await ingestForWallet(w);
    processed += 1;
  }

  return { ok: true, wallets: wallets.length, processed };
}

