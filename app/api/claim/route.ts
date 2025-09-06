// app/api/claim/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { validateTxHash, normalizeChain } from '@/lib/tx-validators';
import { getRateLimiter } from '@/lib/rate-limit';

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

// Resolve base URL for server-to-server call
const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL
  ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

// ---------------------------
// Minimal local limiter: 10 req/h per IP (per instance; best-effort)
// ---------------------------
const mem: Record<string, { count: number; resetAt: number }> = {};
function localLimit(ip: string, limit = 10, windowSec = 3600) {
  const now = Date.now();
  const node = mem[ip];
  if (!node || now > node.resetAt) {
    mem[ip] = { count: 1, resetAt: now + windowSec * 1000 };
    return { ok: true as const };
  }
  node.count += 1;
  if (node.count > limit) {
    const retryAfterSec = Math.ceil((node.resetAt - now) / 1000);
    return { ok: false as const, retryAfterSec };
  }
  return { ok: true as const };
}

// ---------------------------
// Optional hCaptcha verify
// ---------------------------
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

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.ip ||
    'unknown';

  // 1) Local strict 10/h limiter
  const ll = localLimit(`claim:${ip}`, 10, 3600);
  if (!ll.ok) {
    return json(429, { ok: false, error: 'rate_limited', retryAfterSec: ll.retryAfterSec });
  }

  // 2) Optional global Upstash limiter (existing project policy 60/5m)
  const up = getRateLimiter();
  if (up) {
    const res = await up.limit(`claim:${ip}`);
    if (!res.success) {
      const retryAfterSec = Math.max(1, Math.ceil((res.reset - Date.now()) / 1000));
      return json(429, { ok: false, error: 'rate_limited_global', retryAfterSec });
    }
  }

  // 3) Parse body
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

  // 4) hCaptcha (optional)
  const hc = await verifyHCaptcha(body.hcaptchaToken);
  if (!hc.ok) return json(400, { ok: false, chain, tx, error: hc.error });

  if (!CRON_SECRET) {
    return json(500, { ok: false, error: 'server_misconfigured_missing_cron_secret' });
  }

  // 5) Proxy na internu ingest rutu
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
    const payload = {
      ok: !!data?.ok,
      chain,
      tx,
      inserted: data?.inserted ?? null,
      error: data?.error ?? null,
    };

    return json(r.ok ? 200 : 400, payload);
  } catch {
    return json(502, { ok: false, chain, tx, error: 'upstream_error' });
  }
}

