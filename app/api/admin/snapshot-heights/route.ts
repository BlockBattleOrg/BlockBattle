// app/api/admin/snapshot-heights/route.ts
import { NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHAINS = ['BTC','LTC','DOGE','ETH','OP','ARB','POL','AVAX','BSC','ADA','ATOM','XRP','SOL','XLM','TRX'] as const;
const keyH = (c: string) => `${c.toLowerCase()}_last_height`;
const keyB = (c: string) => `${c.toLowerCase()}_last_block`;

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

function getSupabase(rolePreferred = true): { client: SupabaseClient; usingServiceRole: boolean } {
  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL || // <-- allow fallback
    '';
  const sr = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

  if (!url) throw new Error('Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL)');

  if (rolePreferred && sr) {
    return { client: createClient(url, sr, { auth: { persistSession: false } }), usingServiceRole: true };
  }
  if (!anon) throw new Error('Missing Supabase service role and ANON key');
  return { client: createClient(url, anon, { auth: { persistSession: false } }), usingServiceRole: false };
}

export async function POST(req: Request) {
  try {
    const sec = process.env.CRON_SECRET;
    if (sec && req.headers.get('x-cron-secret') !== sec) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { client: sb, usingServiceRole } = getSupabase(true);

    const keys = [...CHAINS.map(keyH), ...CHAINS.map(keyB)];
    const { data, error } = await sb.from('settings').select('key,value').in('key', keys);
    if (error) throw error;

    const map = new Map<string, any>((data ?? []).map((r: any) => [r.key, r.value]));
    const day = todayUTC();

    const rows = CHAINS.map((c) => {
      const height = parseHeight(map.get(keyH(c))) ?? parseHeight(map.get(keyB(c))) ?? 0;
      return { day, chain: c, height };
    });

    const up = await sb.from('heights_daily').upsert(rows as any, { onConflict: 'day,chain' });
    if (up.error) {
      const msg = usingServiceRole
        ? up.error.message
        : `Write failed without service role. Add SUPABASE_SERVICE_ROLE_KEY in Vercel Production or enable an INSERT policy on 'heights_daily' for ANON. Original: ${up.error.message}`;
      return NextResponse.json({ ok: false, error: msg, usingServiceRole }, { status: 500 });
    }

    return NextResponse.json({ ok: true, day, upserted: rows.length, usingServiceRole });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

