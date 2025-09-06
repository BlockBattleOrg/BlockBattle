// app/api/claim/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { validateTxHash, normalizeChain } from '@/lib/tx-validators';
import { getRateLimiter } from '@/lib/rate-limit';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ClaimBody = {
  chain?: string;
  tx?: string;
  hcaptchaToken?: string;
};

const CRON_SECRET = process.env.CRON_SECRET!;
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET || '';
const HCAPTCHA_ENABLED = !!HCAPTCHA_SECRET;

// Server-to-server base URL
const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL
  ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

// Minimal local limiter 10 req/h po IP (per instance)
const mem: Record<string, { count: number; resetAt: number }> = {};
function localLimit(ipKey: string, limit = 10, windowSec = 3600) {
  const now = Date.now();
  const node = mem[ipKey];
  if (!node || now > node.resetAt) {
    mem[ipKey] = { count: 1, resetAt: now + windowSec * 1000 };
    return { ok: true as const };
  }
  node.count += 1;
  if (node.count > limit) {
    const retryAfterSec = Math.ceil((node.resetAt - now) / 1000);
    return { ok: false as const, retryAfterSec };
  }
  return { ok: true as const };
}

async function verifyHCaptcha(token?: string) {
  if (!HCAPTCHA_ENABLED) return { ok: true as const };
  if (!token) return { ok: false as const, error: 'missing hcaptchaToken' };
  try {
    const form = new URLSearchParams();
    form.set('response', token);
    form.set('secret', HCAPTCHA_SECRET);
    const res = await fetch('https://hcaptcha.com/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (!data.success) {
      return { ok: false as const, error: `hcaptcha_failed:${(data['error-codes'] || []).join(',')}` };
    }
    return { ok: true as const };
  } catch {
    return { ok: false as const, error: 'hcaptcha_error' };
  }
}

function json(status: number, payload: Record<string, unknown>) {
  return NextResponse.json(payload, { status });
}

// ---------- NEW: Supabase helper (server role) ----------
function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    (req as any).ip ||
    'unknown';

  // 1) Lokalni limiter
  const ll = localLimit(`claim:${ip}`, 10, 3600);
  if (!ll.ok) {
    return json(429, { ok: false, error: 'rate_limited', retryAfterSec: ll.retryAfterSec });
  }

  // 2) Globalni Upstash (postojeći projektni limiter)
  const up = getRateLimiter();
  if (up) {
    const res = await up.limit(`claim:${ip}`);
    if (!res.success) {
      const retryAfterSec = Math.max(1, Math.ceil((res.reset - Date.now()) / 1000));
      return json(429, { ok: false, error: 'rate_limited_global', retryAfterSec });
    }
  }

  // 3) Body & validacija
  let body: ClaimBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  const chainIn = body.chain?.trim();
  const tx = body.tx?.trim();
  if (!chainIn || !tx) return json(400, { ok: false, error: 'missing_chain_or_tx' });

  const chain = normalizeChain(chainIn);
  if (!chain) return json(400, { ok: false, error: 'unsupported_chain' });

  const valid = validateTxHash(chain, tx);
  if (!valid.ok) return json(400, { ok: false, error: `invalid_tx_format:${valid.reason}` });

  // 4) hCaptcha (opcionalno)
  const hc = await verifyHCaptcha(body.hcaptchaToken);
  if (!hc.ok) return json(400, { ok: false, chain, tx, error: hc.error });

  if (!CRON_SECRET) {
    return json(500, { ok: false, error: 'server_misconfigured_missing_cron_secret' });
  }

  // ---------- NEW: Pre-check u Supabase contributions po tx_hash ----------
  try {
    // Napomena: tablica nema 'chain' kolonu — koristimo samo tx_hash!
    const { data: exists, error: qErr } = await supa()
      .from('contributions')
      .select('id')
      .eq('tx_hash', tx)
      .limit(1)
      .maybeSingle();

    if (qErr) {
      // Ne rušimo — samo logički nastavljamo na ingest.
      // (Ako želiš striktno, možeš vratiti 500 ovdje.)
      // console.error('supabase pre-check error', qErr);
    } else if (exists) {
      // Već je u bazi — idemo biti idempotentni i brzi.
      return json(200, {
        ok: true,
        chain,
        tx,
        inserted: null,
        alreadyRecorded: true,
        error: null,
      });
    }
  } catch {
    // Fallback: nastavi prema ingestu
  }

  // 5) Proxy na internu ingest rutu samo ako nije nađeno
  const url = new URL(`${BASE_URL}/api/ingest/contrib/${chain}`);
  url.searchParams.set('tx', tx);

  try {
    const r = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'x-cron-secret': CRON_SECRET,
        'content-type': 'application/json',
      },
    });

    const data = await r.json().catch(() => ({} as any));

    // Uljepšaj poznatu PG grešku u "već zabilježeno"
    let ok = !!data?.ok;
    let inserted = data?.inserted ?? null;
    let error = data?.error ?? null;
    let alreadyRecorded = false;

    if (!ok && typeof error === 'string' && /no unique or exclusion constraint/i.test(error)) {
      ok = true;
      inserted = null;
      alreadyRecorded = true;
      error = null;
    }

    return json(r.ok ? 200 : ok ? 200 : 400, {
      ok,
      chain,
      tx,
      inserted,
      alreadyRecorded,
      error,
    });
  } catch {
    return json(502, { ok: false, chain, tx, error: 'upstream_error' });
  }
}

