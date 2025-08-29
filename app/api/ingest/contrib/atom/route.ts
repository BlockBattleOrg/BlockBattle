'use server';
import 'server-only';
import { NextResponse, NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

type WalletRow = {
  id: string;
  address: string;
  chain: string;
  is_active: boolean;
};

type Tx = any;

const ATOM_REST_URL =
  (process.env.ATOM_REST_URL || process.env.ATOM_LCD_URL || '').trim();
const NOWNODES_API_KEY = (process.env.NOWNODES_API_KEY || '').trim();
const SUPABASE_URL =
  (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const SUPABASE_SVC_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const CRON_SECRET = (process.env.CRON_SECRET || '').trim();

const ATOM_DENOM = 'uatom';
const ATOM_DECIMALS = 6;

const PAGE_LIMIT = 50;      // per LCD page
const MAX_PAGES = 5;        // safety cap

function jsonError(status: number, message: string, detail?: any) {
  return NextResponse.json({ ok: false, error: message, detail }, { status });
}

function atomFromUatom(u: string | number) {
  const n = typeof u === 'string' ? Number(u) : u;
  return n / 10 ** ATOM_DECIMALS;
}

function isMsgSend(msg: any) {
  const t = msg?.['@type'] || msg?.typeUrl || '';
  return t.includes('cosmos.bank.v1beta1.MsgSend');
}

function isMsgMultiSend(msg: any) {
  const t = msg?.['@type'] || msg?.typeUrl || '';
  return t.includes('cosmos.bank.v1beta1.MsgMultiSend');
}

function amountsToDenomSum(amts: any[], denom: string) {
  let sum = 0;
  for (const a of amts || []) {
    if ((a?.denom || '') === denom) {
      sum += Number(a?.amount || 0);
    }
  }
  return sum;
}

export async function POST(req: NextRequest) {
  try {
    // Auth: simple cron secret header
    const headerSecret = req.headers.get('x-cron-secret') || '';
    if (!CRON_SECRET || headerSecret !== CRON_SECRET) {
      return jsonError(401, 'Unauthorized (cron secret mismatch)');
    }

    // Env guards
    if (!ATOM_REST_URL) return jsonError(500, 'Missing ATOM_REST_URL/ATOM_LCD_URL');
    if (!NOWNODES_API_KEY) return jsonError(500, 'Missing NOWNODES_API_KEY');
    if (!SUPABASE_URL || !SUPABASE_SVC_KEY)
      return jsonError(500, 'Missing Supabase service credentials');

    const supabase = createClient(SUPABASE_URL, SUPABASE_SVC_KEY);

    // 1) Dohvati aktivne cosmos/ATOM wallete
    //    - ili chain='cosmos'
    //    - ili join currencies.symbol='ATOM'
    //    (koristimo dva upita radi jednostavnosti i spajamo rezultate)
    const { data: walletsChain, error: wErr1 } = await supabase
      .from('wallets')
      .select('id,address,chain,is_active')
      .eq('is_active', true)
      .eq('chain', 'cosmos');

    if (wErr1) return jsonError(500, 'DB wallets (chain) error', wErr1.message);

    const { data: walletsBySymbol, error: wErr2 } = await supabase
      .from('wallets')
      .select('id,address,chain,is_active,currency_id,currencies!inner(symbol)')
      .eq('is_active', true)
      .eq('currencies.symbol', 'ATOM');

    if (wErr2) return jsonError(500, 'DB wallets (symbol) error', wErr2.message);

    // Normaliziraj i deduplikacija po id-u
    const map = new Map<string, WalletRow>();
    for (const r of walletsChain || []) {
      map.set(r.id, { id: r.id, address: r.address, chain: r.chain, is_active: r.is_active });
    }
    for (const r of (walletsBySymbol as any[]) || []) {
      map.set(r.id, { id: r.id, address: r.address, chain: r.chain, is_active: r.is_active });
    }
    const wallets = Array.from(map.values());

    if (!wallets.length) {
      return NextResponse.json({
        ok: true,
        skipped: true,
        reason: 'no active cosmos/ATOM wallets',
      });
    }

    // 2) LCD query — za svaku adresu dohvatimo stranice transakcija gdje je recipient = naša adresa
    //    (ponavljamo events parametar za svaku adresu pri jedinstvenom dohvaćanju,
    //     ali da bismo upravljali paginacijom, radije ćemo pullati po jednoj adresi)
    let totalScanned = 0;
    let totalInserted = 0;
    const perWallet: Record<string, { scanned: number; inserted: number }> = {};
    let latestHeight: number | null = null;

    for (const w of wallets) {
      perWallet[w.id] = { scanned: 0, inserted: 0 };

      let page = 0;
      let nextPageKey: string | undefined = undefined;

      // Straničenje: koristimo `pagination.key` ako ga server nudi (Cosmos SDK v0.47+),
      // a u suprotnom `pagination.offset` (fallback).
      do {
        const qs = new URLSearchParams();
        qs.append('events', `transfer.recipient='${w.address}'`);
        qs.set('order_by', 'ORDER_BY_DESC');
        qs.set('limit', String(PAGE_LIMIT));
        if (nextPageKey) qs.set('pagination.key', nextPageKey);

        const url = `${ATOM_REST_URL.replace(/\/+$/, '')}/cosmos/tx/v1beta1/txs?${qs.toString()}`;

        const res = await fetch(url, {
          headers: { 'api-key': NOWNODES_API_KEY },
          cache: 'no-store',
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`LCD ${res.status}: ${detail}`);
        }

        const data = (await res.json()) as {
          txs: Tx[];
          tx_responses: any[];
          pagination?: { next_key?: string | null; total?: string };
        };

        const txs = data?.txs || [];
        const txrs = data?.tx_responses || [];
        nextPageKey = data?.pagination?.next_key || undefined;

        // 3) Parsiranje: MsgSend / MsgMultiSend i iznos u uatom za našu adresu kao recipient
        for (let i = 0; i < txs.length; i++) {
          const tx = txs[i];
          const r = txrs[i] || {};
          const height = Number(r?.height || 0);
          const hash = r?.txhash || r?.hash || '';
          const timestamp = r?.timestamp || null;

          if (height && (!latestHeight || height > latestHeight)) latestHeight = height;

          const msgs: any[] = tx?.body?.messages || [];

          let amountUatomForUs = 0;
          let fromAddress: string | null = null;
          let toAddress: string | null = null;

          for (const m of msgs) {
            if (isMsgSend(m)) {
              // MsgSend { from_address, to_address, amount[] }
              if (m?.to_address === w.address) {
                amountUatomForUs += amountsToDenomSum(m?.amount || [], ATOM_DENOM);
                fromAddress = m?.from_address || fromAddress;
                toAddress = m?.to_address || toAddress;
              }
            } else if (isMsgMultiSend(m)) {
              // MsgMultiSend { inputs[{address, coins[]}], outputs[{address, coins[]}] }
              const outs = m?.outputs || [];
              for (const out of outs) {
                if (out?.address === w.address) {
                  amountUatomForUs += amountsToDenomSum(out?.coins || [], ATOM_DENOM);
                  toAddress = out?.address || toAddress;
                }
              }
              // Heuristika za from (prvi input)
              const ins = m?.inputs || [];
              if (ins?.length && !fromAddress) {
                fromAddress = ins[0]?.address || null;
              }
            }
          }

          // Ako ništa za nas u ovom tx-u, preskoči
          if (!amountUatomForUs) continue;

          const amountAtom = atomFromUatom(amountUatomForUs);

          // 4) Upsert u contributions
          // Ovdje pretpostavljamo jedinstvenost (wallet_id, tx_hash)
          const row = {
            wallet_id: w.id,
            chain: 'cosmos',            // zadržavamo naziv chaina iz wallets
            symbol: 'ATOM',
            amount: amountAtom,
            amount_raw: String(amountUatomForUs),
            tx_hash: hash,
            block_height: height || null,
            block_time: timestamp,      // ISO string
            from_address: fromAddress,
            to_address: toAddress || w.address,
            meta: r || null,            // raw tx_response za debug/audit
          };

          const { error: upErr } = await supabase
            .from('contributions')
            .upsert(row, { onConflict: 'wallet_id,tx_hash' });

          if (upErr && !String(upErr.message || '').includes('duplicate')) {
            // Ako tabla nema onConflict indeks, možeš prebaciti na upsert po tx_hash ili prvo SELECT-pa-INSERT
            throw new Error(`DB upsert error: ${upErr.message}`);
          } else {
            totalInserted += 1;
            perWallet[w.id].inserted += 1;
          }

          totalScanned += 1;
          perWallet[w.id].scanned += 1;
        }

        page += 1;
      } while (nextPageKey && page < MAX_PAGES);
    }

    return NextResponse.json({
      ok: true,
      scanned_wallets: wallets.length,
      scanned: totalScanned,
      inserted: totalInserted,
      latest_height: latestHeight,
      per_wallet: perWallet,
    });
  } catch (e: any) {
    return jsonError(500, 'ATOM ingest failed', String(e?.message || e));
  }
}

