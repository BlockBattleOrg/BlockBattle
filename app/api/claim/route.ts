// app/api/claim/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ClaimBody = { chain?: string; tx?: string; hcaptchaToken?: string; message?: string };

const CRON_SECRET = process.env.CRON_SECRET!;
const HCAPTCHA_SECRET = process.env.HCAPTCHA_SECRET || '';
const CLAIM_BYPASS_SECRET = process.env.CLAIM_BYPASS_SECRET || '';
const HCAPTCHA_ENABLED = !!HCAPTCHA_SECRET;

const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ??
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:3000');

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
    eth: 'eth', optimism: 'op', op: 'op', arbitrum: 'arb', arb: 'arb',
    polygon: 'pol', pol: 'pol', avax: 'avax', bsc: 'bsc',
    btc: 'btc', ltc: 'ltc', doge: 'doge', dot: 'dot',
    atom: 'atom', xrp: 'xrp', sol: 'sol', xlm: 'xlm', trx: 'trx',
  };
  return map[v] ?? null;
}
function normalizeEvmTx(s: string) {
  const raw = s.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(raw)) return raw.toLowerCase();
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return ('0x' + raw).toLowerCase();
  return raw;
}
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
function validateTxHash(chain: string, tx: string) {
  if (!tx) return { ok: false as const, reason: 'empty' };
  if (isEvm(chain)) return /^0x[0-9a-f]{64}$/.test(tx) ? { ok: true as const } : { ok: false as const, reason: 'expect_0x64_hex' };
  if (chain === 'sol') return /^[1-9A-HJ-NP-Za-km-z]{43,88}$/.test(tx) ? { ok: true as const } : { ok: false as const, reason: 'expect_base58' };
  return /^[0-9a-fA-F]{16,}$/.test(tx) ? { ok: true as const } : { ok: false as const, reason: 'expect_hex_like' };
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
    const data = await res.json();
    if (!data?.success) return { ok: false as const, error: `hcaptcha_failed:${(data['error-codes'] || []).join(',')}` };
    return { ok: true as const };
  } catch {
    return { ok: false as const, error: 'hcaptcha_error' };
  }
}

export async function POST(req: NextRequest) {
  let body: ClaimBody;
  try { body = await req.json(); } catch { return json(400, { ok: false, error: 'invalid_json' }); }

  const chain0 = normalizeChain(body.chain);
  if (!chain0) return json(400, { ok: false, error: 'unsupported_chain' });

  let tx = (body.tx || '').trim();
  if (!tx) return json(400, { ok: false, error: 'missing_chain_or_tx' });
  if (isEvm(chain0)) tx = normalizeEvmTx(tx);

  const valid = validateTxHash(chain0, tx);
  if (!valid.ok) return json(400, { ok: false, chain: chain0, error: `invalid_tx_format:${valid.reason}` });

  const message = (body.message || '').trim();
  if (message && message.length > 280) {
    return json(400, { ok: false, error: 'message_too_long' });
  }

  if (!CRON_SECRET) return json(500, { ok: false, error: 'server_misconfigured_missing_cron_secret' });

  // Captcha (unless bypass)
  const bypassHeader = req.headers.get('x-claim-bypass') || '';
  const bypassCaptcha = CLAIM_BYPASS_SECRET && bypassHeader === CLAIM_BYPASS_SECRET;
  if (HCAPTCHA_ENABLED && !bypassCaptcha) {
    const hc = await verifyHCaptcha(body.hcaptchaToken);
    if (!hc.ok) return json(400, { ok: false, chain: chain0, tx, error: hc.error });
  }

  // 1) tolerant DB pre-check
  try {
    const candidates = isEvm(chain0) ? evmVariants(tx) : [tx];
    const { data: rows, error: qErr } = await supa()
      .from('contributions')
      .select('id, tx_hash')
      .in('tx_hash', candidates)
      .limit(1);

    if (!qErr && rows && rows.length > 0) {
      // already recorded -> for safety, do NOT update note here
      return json(200, { ok: true, chain: chain0, tx, inserted: null, alreadyRecorded: true, error: null });
    }
  } catch {
    // ignore and continue
  }

  // 2) forward to ingest (verifies on-chain + inserts)
  const url = new URL(`${BASE_URL}/api/ingest/contrib/${chain0}`);
  url.searchParams.set('tx', tx);

  try {
    const r = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'x-cron-secret': CRON_SECRET, 'content-type': 'application/json' },
    });
    const data = await r.json().catch(() => ({} as any));

    let ok = !!data?.ok;
    let inserted = data?.inserted ?? null;
    let error = data?.error ?? null;
    let alreadyRecorded = false;

    if (!ok && typeof error === 'string' && /duplicate key|unique/i.test(error)) {
      ok = true; inserted = null; alreadyRecorded = true; error = null;
    }
    if (!ok && typeof error === 'string' && /no unique or exclusion constraint matching the ON CONFLICT/i.test(error)) {
      return json(500, { ok: false, chain: chain0, tx, error: 'server_misconfigured_no_unique' });
    }
    if (!ok && typeof error === 'string') {
      if (/tx_not_found|not_found/i.test(error)) return json(404, { ok: false, chain: chain0, tx, error: 'tx_not_found' });
      if (/tx_pending|pending|not_confirmed/i.test(error)) return json(409, { ok: false, chain: chain0, tx, error: 'tx_pending' });
    }

    // 3) If a brand-new insert and we have a message, persist it (once)
    if (ok && !alreadyRecorded && message) {
      await supa()
        .from('contributions')
        .update({ note: message })
        .eq('tx_hash', tx)
        .is('note', null);
      // ignore update error silently; core result still returned
    }

    return json(r.ok ? 200 : ok ? 200 : 400, { ok, chain: chain0, tx, inserted, alreadyRecorded, error });
  } catch {
    return json(502, { ok: false, chain: chain0, tx, error: 'upstream_error' });
  }
}

