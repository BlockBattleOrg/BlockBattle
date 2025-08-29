'use server';
import 'server-only';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

type WalletRow = {
  id: string;
  address: string;
  chain: string;
  is_active: boolean;
};

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env.');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * VAŽNO: ovdje NEMA join-a na `currencies` jer u bazi nije definirana relacija.
 * Uzimamo samo osnovna polja iz `wallets` i filtriramo na serveru.
 */
async function getWallets(): Promise<WalletRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('wallets')
    .select('id,address,chain,is_active')
    .eq('chain', 'cosmos'); // ATOM je na Cosmos Hubu

  if (error) throw error;
  return (data || []).filter(w => w.is_active) as WalletRow[];
}

// helpers za cursor u settings
async function getCursor(key: string): Promise<number> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  const n = (data?.value as any)?.n;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

async function setCursor(key: string, n: number): Promise<void> {
  const supabase = getSupabase();
  await supabase.from('settings').upsert({ key, value: { n } });
}

export async function POST(req: Request) {
  try {
    // simple auth preko x-cron-secret
    const sec = process.env.CRON_SECRET;
    if (sec && req.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    // aktivni ATOM walleti
    const wallets = await getWallets();

    // cursor housekeeping (da je idempotentno i compile-safe)
    const CURSOR_KEY = 'atom_contrib_last_scanned';
    const from = await getCursor(CURSOR_KEY);
    await setCursor(CURSOR_KEY, from);

    // ⚠️ TODO: Ovdje dolazi stvarni skener (Cosmos/NowNodes).
    // Za sada samo vraćamo OK da bi deployment prošao i da nema TS grešaka.
    return NextResponse.json({
      ok: true,
      message: 'ATOM ingest placeholder (compile-safe). Replace with full scanner when ready.',
      wallets: wallets.length,
      from,
      scanned: 0,
      inserted: 0,
    });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: String(err?.message || err) },
      { status: 500 },
    );
  }
}

