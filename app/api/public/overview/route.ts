import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---- Local types ----
type Status = 'ok' | 'stale' | 'issue';
type Row = {
  symbol: string;          // prikazni simbol (npr. 'ETH', 'MATIC')
  height: number | null;   // zadnja visina bloka za današnji dan
  updatedAt: string | null;// timestamp zadnjeg updatea
  status: Status;          // ok/stale/issue po starenju zapisa
};
type Resp = {
  ok: boolean;
  total: number;
  okCount: number;
  staleCount: number;
  issueCount: number;
  rows: Row[];
  error?: string;
};
// ---------------------

function getSupabase() {
  const url =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase env vars');
  return createClient(url, key, { auth: { persistSession: false } });
}

function parseActiveChainsEnv(): string[] | null {
  const raw = process.env.ACTIVE_CHAINS;
  if (!raw) return null;
  return raw
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function statusFromUpdatedAt(
  updatedAt: string | null,
  staleMins = 10,
  issueMins = 60
): Status {
  if (!updatedAt) return 'issue';
  const now = Date.now();
  const ts = new Date(updatedAt).getTime();
  const diffMin = (now - ts) / 60000;
  if (diffMin >= issueMins) return 'issue';
  if (diffMin >= staleMins) return 'stale';
  return 'ok';
}

export async function GET(_req: NextRequest) {
  try {
    const supabase = getSupabase();

    // 1) Wallets -> currency ids (respect is_active)
    const { data: wallets, error: wErr } = await supabase
      .from('wallets')
      .select('currency_id, is_active');

    if (wErr) {
      return NextResponse.json<Resp>(
        { ok: false, error: `wallets: ${wErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] },
        { status: 500 }
      );
    }
    if (!Array.isArray(wallets) || wallets.length === 0) {
      return NextResponse.json<Resp>({ ok: true, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] });
    }

    const use = wallets.some((w: any) => w?.is_active === true)
      ? wallets.filter((w: any) => w?.is_active === true)
      : wallets;

    const currencyIds: string[] = Array.from(
      new Set(use.map((w: any) => w?.currency_id).filter((x: any) => x != null))
    );
    if (currencyIds.length === 0) {
      return NextResponse.json<Resp>({ ok: true, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] });
    }

    // 2) currencies -> symbols
    const { data: currencies, error: cErr } = await supabase
      .from('currencies')
      .select('id, symbol')
      .in('id', currencyIds);

    if (cErr) {
      return NextResponse.json<Resp>(
        { ok: false, error: `currencies: ${cErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] },
        { status: 500 }
      );
    }

    const envSymbols = parseActiveChainsEnv(); // optional override
    const symbols = envSymbols ?? Array.from(
      new Set((currencies ?? []).map((c: any) => String(c.symbol).toUpperCase()))
    );

    if (symbols.length === 0) {
      return NextResponse.json<Resp>({ ok: true, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] });
    }

    // 3) heights_daily za *današnji dan* i tražene chain-ove/simbol(e)
    //    Shema: heights_daily(day, chain, height, updated_at)
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const { data: hdRows, error: hErr } = await supabase
      .from('heights_daily')
      .select('chain, height, updated_at, day')
      .eq('day', today)
      .in('chain', symbols)
      .order('updated_at', { ascending: false, nullsFirst: false });

    if (hErr) {
      return NextResponse.json<Resp>(
        { ok: false, error: `heights_daily: ${hErr.message}`, total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] },
        { status: 500 }
      );
    }

    // 4) Uzmi najsvježiji zapis po chain-u
    const latestByChain = new Map<string, { height: number | null; updatedAt: string | null }>();
    (hdRows ?? []).forEach((r: any) => {
      const key = String(r.chain).toUpperCase();
      if (!latestByChain.has(key)) {
        latestByChain.set(key, {
          height: r.height == null ? null : Number(r.height),
          updatedAt: r.updated_at ?? null,
        });
      }
    });

    // Ako za neki simbol nema zapisa danas, postavi null-ove
    const rows: Row[] = symbols.map((s) => {
      const entry = latestByChain.get(s) ?? { height: null, updatedAt: null };
      return {
        symbol: s,
        height: entry.height,
        updatedAt: entry.updatedAt,
        status: statusFromUpdatedAt(entry.updatedAt),
      };
    });

    const okCount = rows.filter((r) => r.status === 'ok').length;
    const staleCount = rows.filter((r) => r.status === 'stale').length;
    const issueCount = rows.filter((r) => r.status === 'issue').length;

    return NextResponse.json<Resp>({
      ok: true,
      total: rows.length,
      okCount,
      staleCount,
      issueCount,
      rows,
    });
  } catch (e: any) {
    return NextResponse.json<Resp>(
      { ok: false, error: String(e?.message || e), total: 0, okCount: 0, staleCount: 0, issueCount: 0, rows: [] },
      { status: 500 }
    );
  }
}

