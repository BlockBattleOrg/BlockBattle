// lib/settings.ts
import { createClient } from '@supabase/supabase-js';

const url =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (!url) throw new Error('Missing SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL');
if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY');

// Server-side client (no session persistence)
const supabase = createClient(url, key, { auth: { persistSession: false } });

export async function getIntSetting(key: string): Promise<number | null> {
  const { data, error } = await supabase
    .from('settings')
    .select('value')
    .eq('key', key)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const v = (data as any).value?.n;
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  return Number.isFinite(n) ? n : null;
}

export async function setIntSetting(key: string, n: number): Promise<void> {
  const { error } = await supabase
    .from('settings')
    .upsert({ key, value: { n } });
  if (error) throw error;
}

