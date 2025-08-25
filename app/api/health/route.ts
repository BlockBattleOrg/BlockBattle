// app/api/health/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const CHAINS = ['BTC','LTC','DOGE','ETH','OP','ARB','POL','AVAX','DOT','ADA','ATOM','XRP','SOL','XLM','TRX'] as const;
const keyH = (c: string) => `${c.toLowerCase()}_last_height`;
const keyB = (c: string) => `${c.toLowerCase()}_last_block`;

function getSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function parseHeight(v: any): number | null {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'object' && Number.isFinite(Number((v as any).n))) return Number((v as any).n);
  return null;
}

export async function GET() {
  const version = process.env.npm_package_version || '0.0.0';
  const now = new Date().toISOString();

  const env = {
    supabase: Boolean(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL),
    nownodes: Boolean(process.env.NOWNODES_API_KEY),
  };

  let updated = 0;
  let total = CHAINS.length;

  try {
    const sb = getSupabase();
    if (!sb) {
      return NextResponse.json({ ok: false, version, time: now, env, error: 'Supabase env missing' }, { status: 500 });
    }
    const keys = [...CHAINS.map(keyH), ...CHAINS.map(keyB)];
    const { data, error } = await sb.from('settings').select('key,value').in('key', keys);
    if (error) throw error;
    const map = new Map<string, any>((data ?? []).map((r: any) => [r.key, r.value]));
    for (const c of CHAINS) {
      const h = parseHeight(map.get(keyH(c))) ?? parseHeight(map.get(keyB(c)));
      if (h != null) updated++;
    }
    return NextResponse.json({ ok: true, version, time: now, env, chains: { updated, total } });
  } catch (e: any) {
    return NextResponse.json({ ok: false, version, time: now, env, error: e?.message || 'Unexpected error' }, { status: 500 });
  }
}

