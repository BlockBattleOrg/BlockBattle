'use server';
import 'server-only';
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * ATOM (Cosmos Hub) contribution ingest via NowNodes LCD.
 * - Queries txs where recipient == our wallet (event filter).
 * - Parses MsgSend / MsgMultiSend and sums uatom -> ATOM.
 * - Upserts into public.contributions idempotently by (wallet_id, tx_hash).
 *
 * ENV (Vercel):
 *   - ATOM_LCD_URL  or ATOM_REST_URL   (e.g. https://atom.nownodes.io)
 *   - NOWNODES_API_KEY
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *   - CRON_SECRET  (header: x-cron-secret)
 */

type WalletRow = {
  id: string;
  address: string;
  chain: string;
  is_active: boolean;
};

type TxEventMsg = {
  '@type'?: string;
  // MsgSend
  from_address?: string;
  to_address?: string;
  amount?: { denom?: string; amount?: string }[];
  // MsgMultiSend
  inputs?: { address?: string; coins?: { denom?: string; amount?: string }[] }[];
  outputs?: { address?: string; coins?: { denom?: string; amount?: string }[] }[];
};

type TxBody = { messages?: TxEventMsg[] };
type TxObj  = { body?: TxBody };
type TxResp = { txhash?: string; height?: string; timestamp?: string };

type TxSearchResponse = {
  txs?: TxObj[];
  tx_responses?: TxResp[];
  pagination?: { next_key?: string | null };
};

const LCD_BASE =
  (process.env.ATOM_LCD_URL ||
   process.env.ATOM_REST_URL ||
   '').trim();

const NOWNODES_API_KEY = (process.env.NOWNODES_API_KEY || '').trim();
const SUPABASE_URL     = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const CRON_SECRET      = (process.env.CRON_SECRET || '').trim();

const HTTP_TIMEOUT_MS = 15000;
const PAGE_LIMIT      = 50;
const MAX_PAGES       = 5;

const ATOM_DENOM     = 'uatom';
const ATOM_DECIMALS  = 6; // uatom -> ATOM

function err(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

function getSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SVC_KEY) throw new Error('Missing Supabase env');
  return createClient(SUPABASE_URL, SUPABASE_SVC_KEY, { auth: { persistSession: false } });
}

async function lcdGET<T>(path: string, qs?: Record<string, any>): Promise<T> {
  if (!LCD_BASE) throw new Error('Missing ATOM LCD base URL (ATOM_LCD_URL|ATOM_REST_URL)');
  if (!NOWNODES_API_KEY) throw new Error('Missing NOWNODES_API_KEY');

  const base = LCD_BASE.endsWith('/') ? LCD_BASE : LCD_BASE + '/';
  const url  = new URL(path.replace(/^\/+/, ''), base);
  if (qs) {
    for (const [k, v] of Object.entries(qs)) {
      if (v !== undefined && v !== null && v !== '') {
        if (Array.isArray(v)) {
          // repeatable params: events=...&events=...
          v.forEach((vv) => url.searchParams.append(k, String(vv)));
        } else {
          url.searchParams.set(k, String(v));
        }
      }
    }
  }

  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'api-key': NOWNODES_API_KEY,   // NowNodes header
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status} ${text.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(to);
  }
}

async function getLatestHeight(): Promise<number> {
  const j = await lcdGET<any>('/cosmos/base/tendermint/v1beta1/blocks/latest');
  const h = Number(j?.block?.header?.height);
  return Number.isFinite(h) ? h : 0;
}

async function getCursor(key: string): Promise<number> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();
  if (error) throw error;
  const n = (data?.value as any)?.n;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

async function setCursor(key: string, n: number): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase.from('settings').upsert({ key, value: { n } });
  if (error) throw error;
}

async function getActiveAtomWallets(): Promise<WalletRow[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('wallets')
    .select('id,address,chain,is_active')
    .in('chain', ['cosmos', 'atom']); // podrži oba naziva
  if (error) throw error;

  const rows: WalletRow[] = (data ?? []).map((r: any) => ({
    id: String(r.id),
    address: String(r.address || ''),
    chain: String(r.chain || ''),
    is_active: !!r.is_active,
  }));

  return rows.filter(w => w.is_active && w.address.startsWith('cosmos1'));
}

function sumToRecipient(msgs: TxEventMsg[] | undefined, recip: string): bigint {
  if (!msgs?.length) return 0n;
  let total = 0n;

  for (const m of msgs) {
    const t = m['@type'] || '';
    // MsgSend
    if (t.endsWith('MsgSend')) {
      if (m.to_address === recip && Array.isArray(m.amount)) {
        for (const c of m.amount) {
          if ((c.denom || '') === ATOM_DENOM) {
            total += BigInt(c.amount || '0');
          }
        }
      }
    }
    // MsgMultiSend
    if (t.endsWith('MsgMultiSend')) {
      if (Array.isArray(m.outputs)) {
        for (const out of m.outputs) {
          if (out.address === recip) {
            for (const c of (out.coins || [])) {
              if ((c.denom || '') === ATOM_DENOM) {
                total += BigInt(c.amount || '0');
              }
            }
          }
        }
      }
    }
  }
  return total;
}

async function upsertContribution(wallet_id: string, tx_hash: string, amount_tokens: number, block_time_iso: string): Promise<boolean> {
  const supabase = getSupabase();

  const { data: exists, error: selErr } = await supabase
    .from('contributions')
    .select('id')
    .eq('wallet_id', wallet_id)
    .eq('tx_hash', tx_hash)
    .limit(1);

  if (selErr) throw selErr;
  if (exists && exists.length) return false;

  const { error: insErr } = await supabase.from('contributions').insert({
    wallet_id,
    tx_hash,
    amount: amount_tokens,
    block_time: block_time_iso,
  });

  if (insErr) throw insErr;
  return true;
}

async function scanForRecipient(addr: string): Promise<TxSearchResponse> {
  // Primarni filter: transfer.recipient='<addr>'
  const first = await lcdGET<TxSearchResponse>('/cosmos/tx/v1beta1/txs', {
    events: [`transfer.recipient='${addr}'`],
    order_by: 'ORDER_BY_DESC',
    limit: PAGE_LIMIT,
  });
  // Ako baš ništa, probaj fallback na message.recipient (neke chain konfiguracije ovako indeksiraju)
  const count = (first?.tx_responses?.length ?? 0);
  if (count > 0) return first;

  const fallback = await lcdGET<TxSearchResponse>('/cosmos/tx/v1beta1/txs', {
    events: [`message.recipient='${addr}'`],
    order_by: 'ORDER_BY_DESC',
    limit: PAGE_LIMIT,
  });
  return fallback;
}

export async function POST(req: Request) {
  try {
    // auth
    if (CRON_SECRET) {
      const got = (req.headers.get('x-cron-secret') || '').trim();
      if (got !== CRON_SECRET) return err(401, 'Unauthorized');
    }

    // preconditions
    if (!LCD_BASE) return err(500, 'Missing ATOM LCD base URL (ATOM_LCD_URL|ATOM_REST_URL)');
    if (!NOWNODES_API_KEY) return err(500, 'Missing NOWNODES_API_KEY');

    // latest height i cursor housekeeping
    const CURSOR_KEY = 'atom_contrib_last_scanned';
    const [latest, prev] = await Promise.all([getLatestHeight(), getCursor(CURSOR_KEY)]);
    if (latest && latest !== prev) await setCursor(CURSOR_KEY, latest);

    const wallets = await getActiveAtomWallets();
    if (!wallets.length) {
      return NextResponse.json({ ok: true, scanned_wallets: 0, scanned: 0, inserted: 0, latest_height: latest });
    }

    let totalScanned = 0;
    let totalInserted = 0;
    const perWallet: Record<string, { scanned: number; inserted: number }> = {};

    for (const w of wallets) {
      const addr = w.address;
      perWallet[addr] = { scanned: 0, inserted: 0 };

      let page = 0;
      let next_key: string | null | undefined = undefined;

      while (page < MAX_PAGES) {
        const qs: Record<string, any> = {
          events: [`transfer.recipient='${addr}'`],
          order_by: 'ORDER_BY_DESC',
          limit: PAGE_LIMIT,
        };
        if (next_key) qs['pagination.key'] = next_key;

        let resp = await lcdGET<TxSearchResponse>('/cosmos/tx/v1beta1/txs', qs);

        // fallback na message.recipient ako ništa (samo za prvu stranicu)
        if ((resp?.tx_responses?.length ?? 0) === 0 && page === 0) {
          const fbQs: Record<string, any> = { ...qs, events: [`message.recipient='${addr}'`] };
          resp = await lcdGET<TxSearchResponse>('/cosmos/tx/v1beta1/txs', fbQs);
        }

        const txs = resp.txs || [];
        const resps = resp.tx_responses || [];
        if (!txs.length || !resps.length) break;

        for (let i = 0; i < Math.min(txs.length, resps.length); i++) {
          const tx = txs[i];
          const tr = resps[i];

          totalScanned++;
          perWallet[addr].scanned++;

          const sumU = sumToRecipient(tx?.body?.messages || [], addr);
          if (sumU <= 0n) continue;

          const amount = Number(sumU) / Math.pow(10, ATOM_DECIMALS);
          const hash   = String(tr?.txhash || '');
          const tsIso  = String(tr?.timestamp || new Date().toISOString());

          if (!hash) continue;

          const inserted = await upsertContribution(w.id, hash, amount, tsIso);
          if (inserted) {
            totalInserted++;
            perWallet[addr].inserted++;
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
      latest_height: latest,
      per_wallet: perWallet,
    });
  } catch (e: any) {
    return err(500, `ATOM ingest failed: ${String(e?.message || e)}`);
  }
}

