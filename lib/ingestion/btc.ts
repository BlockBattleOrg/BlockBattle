// lib/ingestion/btc.ts
import { getSupabaseAdmin } from "../supabaseAdmin";
import { fetchIncomingForAddress, BtcTx } from "../providers/btc/blockstream";

type Currency = { id: string; symbol: string; decimals?: number | null };
type Wallet = { id: string; address: string; is_active?: boolean | null; currency_id: string };

const BTC_DECIMALS = 8;

// In-run USD rate cache to minimize DB reads for the same day
const usdCache = new Map<string, number | null>();

async function getBtcCurrency(): Promise<Currency> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("currencies")
    .select("id, symbol, decimals")
    .eq("symbol", "BTC")
    .single();
  if (error || !data) throw new Error("BTC currency not found");
  return data;
}

async function getActiveBtcWallets(currencyId: string): Promise<Wallet[]> {
  const supabase = getSupabaseAdmin();
  // If you added wallets.is_active, filter it; otherwise remove .eq("is_active", true)
  const { data, error } = await supabase
    .from("wallets")
    .select("id, address, is_active, currency_id")
    .eq("currency_id", currencyId)
    .eq("is_active", true);
  if (error) throw error;
  return data ?? [];
}

function toAmountBTC(sats: number, decimals: number): number {
  return Number((sats / Math.pow(10, decimals)).toFixed(decimals));
}

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

  const usd = (data.value && typeof data.value.usd === "number") ? data.value.usd : null;
  usdCache.set(day, usd);
  return usd;
}

type InsertContribution = {
  wallet_id: string;
  currency_id: string;
  tx_hash: string;
  amount_raw: string;
  amount: number;
  amount_usd: number | null;
  tx_timestamp: string;
  source: string;
};

async function upsertContributions(rows: InsertContribution[]) {
  if (!rows.length) return;
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("contributions")
    .upsert(rows, { onConflict: "wallet_id,tx_hash" });
  if (error) throw error;
}

async function ingestForWallet(wallet: Wallet, currency: Currency) {
  const incoming: BtcTx[] = await fetchIncomingForAddress(wallet.address);
  if (!incoming.length) return;

  const decimals = currency.decimals ?? BTC_DECIMALS;

  const rows: InsertContribution[] = [];
  for (const tx of incoming) {
    const amount = toAmountBTC(tx.satoshis, decimals);
    const usdRate = await getUsdRateFor(tx.timestamp);
    rows.push({
      wallet_id: wallet.id,
      currency_id: currency.id,
      tx_hash: tx.txid,
      amount_raw: String(tx.satoshis),
      amount,
      amount_usd: usdRate ? Number((amount * usdRate).toFixed(2)) : null,
      tx_timestamp: tx.timestamp,
      source: "blockstream",
    });
  }
  await upsertContributions(rows);
}

export async function runBtcIngestion(): Promise<{ inserted: number; wallets: number }> {
  const currency = await getBtcCurrency();
  const wallets = await getActiveBtcWallets(currency.id);
  let processedWallets = 0;
  for (const w of wallets) {
    await ingestForWallet(w, currency);
    processedWallets += 1;
  }
  return { inserted: processedWallets, wallets: wallets.length };
}

