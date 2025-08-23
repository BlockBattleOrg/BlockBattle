// app/api/ingest/doge/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdmin';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// ---------- ENV & helpers ----------
const supabase = getSupabaseAdmin();

const withSlash = (u?: string | null) => {
  if (!u) return '';
  return u.endsWith('/') ? u : u + '/';
};

const DOGE_RPC_URL = withSlash(process.env.DOGE_RPC_URL); // npr. https://go.getblock.io/<key>/
const SOCHAIN_BASE =
  (process.env.DOGE_API_URLS || 'https://sochain.com/api/v2')
    .split(',')
    .map(s => s.trim())
    .find(u => u.includes('sochain.com')) || 'https://sochain.com/api/v2';

const CURSOR_KEY = 'doge_last_height';
const START_LAG = Number(process.env.DOGE_START_LAG ?? 3);
const MAX_HEIGHTS = Number(process.env.DOGE_MAX_HEIGHTS ?? 20);
const DEADLINE_MS = Number(process.env.DOGE_DEADLINE_MS ?? 50000);
const PER_REQ_TIMEOUT_MS = Number(process.env.DOGE_PER_REQ_TIMEOUT_MS ?? 10000);

const toLower = (s?: string | null) => (s ? s.toLowerCase() : null);
function satsToDecimalString(sats: number | undefined | null): string {
  const v = BigInt(Math.max(0, Number(sats || 0)));
  const base = 10n ** 8n;
  const whole = v / base;
  const frac = v % base;
  const fs = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return fs ? `${whole}.${fs}` : whole.toString();
}

function deadlineGuard(start: number, budgetMs = DEADLINE_MS) {
  return () => Date.now() - start > budgetMs;
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs = PER_REQ_TIMEOUT_MS) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

// ---------- JSON-RPC (GetBlock) ----------
let rpcCounter = 0;
async function rpcCall<T = any>(method: string, params: any[] = [], timeoutMs = PER_REQ_TIMEOUT_MS): Promise<T> {
  if (!DOGE_RPC_URL) throw new Error('DOGE_RPC_URL not set');
  rpcCounter++;
  const body = JSON.stringify({ jsonrpc: '2.0', id: rpcCounter, method, params });
  const res = await fetchWithTimeout(DOGE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, timeoutMs);
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} ${await res.text()}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method} error: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

async function getTipHeightRPC(): Promise<number> {
  const n = await rpcCall<number>('getblockcount', []);
  if (!Number.isFinite(n)) throw new Error('Bad blockcount');
  return n;
}

async function getBlockHashByHeightRPC(h: number): Promise<string> {
  const hash = await rpcCall<string>('getblockhash', [h]);
  if (!hash || hash.length < 32) throw new Error(`Bad blockhash @${h}`);
  return hash;
}

// verbosity 1 => txids array; verbosity 2 => full tx objects (puno teže/parsiranja).
// Koristimo 1 (txids), a detalje adresa dohvaćamo preko SoChain radi jednostavnosti.
type RpcBlockV1 = { hash: string; height: number; time?: number; tx?: string[] };
async function getBlockV1RPC(hashOrHeight: string | number): Promise<RpcBlockV1> {
  // Ako pošalješ decimalni height, Bitcoin Core očekuje hash; zato uvijek šaljemo hash.
  const useHash = String(hashOrHeight);
  const blk = await rpcCall<any>('getblock', [useHash, 1]);
  const tx = Array.isArray(blk?.tx) ? blk.tx.map((x: any) => String(x)) : [];
  return {
    hash: String(blk?.hash || useHash),
    height: Number(blk?.height ?? -1),
    time: Number(blk?.time || Math.floor(Date.now() / 1000)),
    tx,
  };
}

// ---------- SoChain adapters (za adrese/iznose) ----------
type SoTx = {
  time?: number;
  inputs?: Array<{ from_output?: { address?: string; value?: string } }>;
  outputs?: Array<{ address?: string; value?: string }>;
};
async function getTxDetailSoChain(txid: string): Promise<{
  tsIso: string; vouts: Array<{ address: string; valueSats: number }>
}> {
  const url = `${SOCHAIN_BASE.replace(/\/+$/,'')}/get_tx/DOGE/${txid}`;
  const j = await (async () => {
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    return res.json();
  })();
  const t: SoTx = j?.data ?? {};
  const tsIso = new Date(Number(t?.time || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const vouts = (t?.outputs ?? []).map((o: any) => ({
    address: String(o?.address || ''),
    valueSats: Math.round(parseFloat(o?.value || '0') * 1e8),
  }));
  return { tsIso, vouts };
}

// ---------- DB helpers ----------
async function getActiveWallets(): Promise<Array<{ id: string; address: string }>> {
  const { data, error } = await supabase
    .from('wallets').select('id,address')
    .in('chain', ['DOGE', 'doge', 'dogecoin'])
    .eq('is_active', true);
  if (error) throw error;
  return data ?? [];
}

async function getCursor(): Promise<number | null> {
  const { data, error } = await supabase
    .from('settings').select('value').eq('key', CURSOR_KEY).maybeSingle();
  if (error) throw error;
  const n = Number(data?.value?.n);
  return Number.isFinite(n) ? n : null;
}

async function setCursor(n: number): Promise<void> {
  const { error } = await supabase
    .from('settings')
    .upsert({ key: CURSOR_KEY, value: { n }, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  if (error) throw error;
}

async function insertContribution(wallet_id: string, tx_hash: string, amountStr: string, ts: string) {
  try {
    const { error } = await supabase.from('contributions').insert({
      wallet_id, tx_hash, amount: amountStr, amount_usd: null, block_time: ts
    });
    if (error) throw error;
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/duplicate key value violates unique constraint/i.test(msg)) return;
    throw e;
  }
}

// ---------- Handler ----------
export async function POST(req: NextRequest) {
  const supplied = req.headers.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;
  if (!expected || supplied !== expected) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const t0 = Date.now();
  const isOver = deadlineGuard(t0, DEADLINE_MS);

  try {
    const wallets = await getActiveWallets();
    if (!wallets.length) {
      return NextResponse.json({ ok: true, message: 'No active DOGE wallets.', inserted: 0 });
    }

    // mapa adresa -> wallet_id
    const addrMap = new Map<string, string>();
    for (const w of wallets) { const k = toLower(w.address || ''); if (k) addrMap.set(k, w.id); }

    // dohvat visine
    const tip = await getTipHeightRPC();
    const cursor = await getCursor();
    const start = Math.max(0, (cursor ?? (tip - START_LAG)) + 1);
    const end = Math.min(tip, start + MAX_HEIGHTS - 1);
    if (end < start) {
      return NextResponse.json({ ok: true, message: 'Up to date.', tip, processed: 0 });
    }

    let inserted = 0;
    let processedHeights = 0;
    let partial = false;
    let firstTs: string | null = null;
    let lastTs: string | null = null;

    for (let h = start; h <= end; h++) {
      if (isOver()) { partial = true; break; }

      // hash + block (txids)
      const hash = await getBlockHashByHeightRPC(h);
      const blk = await getBlockV1RPC(hash);

      const blockTs = new Date((blk.time ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
      for (const txid of blk.tx || []) {
        if (isOver()) { partial = true; break; }
        // SoChain za adrese/iznose
        let detail: { tsIso: string; vouts: Array<{ address: string; valueSats: number }> } | null = null;
        try {
          detail = await getTxDetailSoChain(txid);
        } catch {
          // Ako SoChain zakaže, preskačemo taj tx (ne rušimo cijeli run)
          continue;
        }
        const ts = detail.tsIso || blockTs;
        if (!firstTs) firstTs = ts; lastTs = ts;

        for (const o of detail.vouts) {
          const a = toLower(o.address || ''); if (!a || !addrMap.has(a)) continue;
          await insertContribution(addrMap.get(a)!, txid, satsToDecimalString(o.valueSats), ts);
          inserted++;
        }
      }

      processedHeights++;
      if ((h - start) % 3 === 0) await setCursor(h);
    }

    // finalni cursor
    if (!partial) await setCursor(start + processedHeights - 1);

    const body: any = {
      ok: true,
      chain: 'DOGE',
      tip,
      range: { start, end: start + processedHeights - 1 },
      processed_heights: processedHeights,
      inserted,
      time_window: { firstTs, lastTs },
      provider: 'rpc+sochain',
    };
    if (partial) {
      body.partial = true;
      body.reason = 'deadline';
    }
    return NextResponse.json(body);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error('DOGE ingest error:', msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

