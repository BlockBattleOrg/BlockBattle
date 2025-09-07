// app/api/claim/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
// If you already have these helpers elsewhere, keep imports;
// below are small inlined fallbacks for safety.
type ValidateResult = { ok: true } | { ok: false; reason: string };

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ClaimBody = { chain?: string; tx?: string; hcaptchaToken?: string };

const CRON_SECRET = process.env.CRON_SECRET!;
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET || '';
const CLAIM_BYPASS_SECRET = process.env.CLAIM_BYPASS_SECRET || '';
const HCAPTCHA_ENABLED = !!HCAPTCHA_SECRET;

const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

// ---------- utils ----------
function json(status: number, payload: Record<string, unknown>) {
  return NextResponse.json(payload, { status });
}

function supa() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  return createClient(url, key, { auth: { persistSession: false } });
}

const EVM_CHAINS = ['eth', 'op', 'arb', 'pol', 'avax', 'bsc'] as const;
const isEvm = (c: string) => (EVM_CHAINS as unknown as string[]).includes(c);

function normalizeChain(input?: string): string | null {
  if (!input) return null;
  const v = input.toLowerCase().trim();
  const map: Record<string, string> = {
    eth: 'eth',
    op: 'op',
    optimism: 'op',
    arb: 'arb',
    arbitrum: 'arb',
    pol: 'pol',
    polygon: 'pol',
    avax: 'avax',
    bsc: 'bsc',
    btc: 'btc',
    ltc: 'ltc',
    doge: 'doge',
    dot: 'dot',
    atom: 'atom',
    xrp: 'xrp',
    sol: 'sol',
    xlm: 'xlm',
    trx: 'trx',
  };
  return map[v] ?? null;
}

// Accept 64-hex without 0x, emit 0x + lowercase
function normalizeEvmTx(s: string) {
  const raw = s.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return ('0x' + raw).toLowerCase();
  return raw;
}

// Build variant set for tolerant DB lookup (0x/no-0x, casing)
function evmVariants(s: string) {
  const set = new Set<string>();
  const a = s.trim();
  set.add(a);
  if (/^0x[0-9a-fA-F]{64}$/.test(a)) {
    set.add(a.toLowerCase());
    set.add(a.slice(2).toLowerCase());
  } else if (/^[0-9a-fA-F]{64}$/.test(a)) {
    set.add(('0x' + a).toLowerCase());
    set.add(a.toLowerCase());
  }
  return Array.from(set);
}

// Minimal validators (adapt/replace with your lib/tx-validators if present)
function validateTxHash(chain: string, tx: string): ValidateResult {
  if (!tx) return { ok: false, reason: 'empty' };
  if (isEvm(chain)) {
    if (!/^0x[0-9a-f]{64}$/.test(tx)) return { ok: false, reason: 'expect_0x64_hex' };
    return { ok: true };
  }
  if (chain === 'sol') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(tx)) return { ok: false, reason: 'expect_base58' };
    return { ok: true };
  }
  // Generic relaxed check for UTXO/others (hex-ish, no 0x)
  if (!/^[0-9a-fA-F]{16,}$/.test(tx)) return { ok: false, reason: 'expect_hex_like' };
  return { ok: true };
}

async function verifyHCaptcha(token?: string) {
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

// ---------- handler ----------
export async function POST(req: NextRequest) {
  // simple per-IP limiter (best-effort)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || (req as any).ip || 'unknown';

  let body: ClaimBody;
  try {
    body = await req.json();
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  const chain0 = normalizeChain(body.chain);
  if (!chain0) return json(400, { ok: false, error: 'unsupported_chain' });

  let tx = (body.tx || '').trim();
  if (!tx) return json(400, { ok: false, error: 'missing_chain_or_tx' });

  if (isEvm(chain0)) tx = normalizeEvmTx(tx);

  const valid = validateTxHash(chain0, tx);
  if (!valid.ok) return json(400, { ok: false, chain: chain0, error: `invalid_tx_format:${valid.reason}` });

  if (!CRON_SECRET) return json(500, { ok: false, error: 'server_misconfigured_missing_cron_secret' });

  // Captcha unless bypass header is present & correct
  const bypassHeader = req.headers.get('x-claim-bypass') || '';
  const bypassCaptcha = CLAIM_BYPASS_SECRET && bypassHeader === CLAIM_BYPASS_SECRET;
  if (HCAPTCHA_ENABLED && !bypassCaptcha) {
    const hc = await verifyHCaptcha(body.hcaptchaToken);
    if (!hc.ok) return json(400, { ok: false, chain: chain0, tx, error: hc.error });
  }

  // 1) tolerant pre-check in DB (search variants for EVM)
  try {
    const candidates = isEvm(chain0) ? evmVariants(tx) : [tx];
    const { data: rows, error: qErr } = await supa()
      .from('contributions')
      .select('id, tx_hash')
      .in('tx_hash', candidates)
      .limit(1);

    if (!qErr && rows && rows.length > 0) {
      return json(200, { ok: true, chain: chain0, tx, inserted: null, alreadyRecorded: true, error: null });
    }
  } catch {
    // ignore and continue to ingest
  }

  // 2) forward to internal ingest verifier/writer (chain proof + insert)
  const url = new URL(`${BASE_URL}/api/ingest/contrib/${chain0}`);
  url.searchParams.set('tx', tx);

  try {
    const r = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'x-cron-secret': CRON_SECRET,
        'content-type': 'application/json',
        // body intentionally empty; ingest reads tx from query
      },
    });

    const data = await r.json().catch(() => ({} as any));

    let ok: boolean = !!data?.ok;
    let inserted = data?.inserted ?? null;
    let error = data?.error ?? null;
    let alreadyRecorded = false;

    // interpret duplicate-key/unique violations as "already recorded"
    if (!ok && typeof error === 'string' && /duplicate key|unique|no unique or exclusion constraint/i.test(error)) {
      ok = true;
      inserted = null;
      alreadyRecorded = true;
      error = null;
    }

    // propagate meaningful states from ingest
    if (!ok && typeof error === 'string') {
      if (/tx_not_found|not_found/i.test(error)) {
        return json(404, { ok: false, chain: chain0, tx, error: 'tx_not_found' });
      }
      if (/tx_pending|pending|not_confirmed/i.test(error)) {
        return json(409, { ok: false, chain: chain0, tx, error: 'tx_pending' });
      }
    }

    return json(r.ok ? 200 : ok ? 200 : 400, {
      ok,
      chain: chain0,
      tx,
      inserted,
      alreadyRecorded,
      error,
    });
  } catch {
    return json(502, { ok: false, chain: chain0, tx, error: 'upstream_error' });
  }
}

