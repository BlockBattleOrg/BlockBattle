// app/api/admin/snapshot-heights/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHAINS = ['BTC','LTC','DOGE','ETH','OP','ARB','POL','AVAX','DOT','ADA','ATOM','XRP','SOL','XLM','TRX'] as const;
const keyH = (c: string) => `${c.toLowerCase()}_last_height`;
const keyB = (c: string) => `${c.toLowerCase()}_last_block`;

function getSupabaseSR() {
  const url = process.env.SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Missing Supabase service role env');
  return createClient(url, key, { auth: { persistSession: false } });
}

function parseHeight(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'object' && Number.isFinite(Number((v as any).n))) return Number((v as any).n);
  return null;
}

function todayUTC(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

export async function POST(req: Request) {
  try {
    // protect with cron secret
    const sec = process.env.CRON_SECRET;
    if (sec && req.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const sb = getSupabaseSR();
    const keys = [...CHAINS.map(keyH), ...CHAINS.map(keyB)];
    const { data, error } = await sb.from('settings').select('key,value').in('key', keys);
    if (error) throw error;

    const map = new Map<string, any>((data ?? []).map((r: any) => [r.key, r.value]));
    const day = todayUTC();

    const rows = CHAINS.map((c) => {
      const height = parseHeight(map.get(keyH(c))) ?? parseHeight(map.get(keyB(c))) ?? 0;
      return { day, chain: c, height };
    });

    const { error: upErr } = await sb.from('heights_daily').upsert(rows as any, { onConflict: 'day,chain' });
    if (upErr) throw upErr;

    return NextResponse.json({ ok: true, day, upserted: rows.length });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

