// app/api/claim-ingest/eth/route.ts
// Claim-first ETH ingest route.
// Reads a user-submitted transaction hash, verifies it's a donation to one of our project wallets (chain='eth'),
// and records it into `contributions` according to the Supabase schema.
//
// Table: contributions
//   - wallet_id (uuid, FK wallets.id)
//   - tx_hash (text, unique)
//   - amount (text or numeric stored as string – store full native precision in ETH as string)
//   - amount_usd (numeric, nullable)  // Option B: leave NULL for now
//   - block_time (timestamptz)
//   - priced_at (timestamptz, nullable) // Option B: set to now()
//   - note (text, nullable)
// Table: wallets
//   - id (uuid)
//   - address (text, ideally stored lowercase, with or without 0x)
//   - chain (text) e.g. 'eth'
//
// Response contract (always HTTP 200):
//   { ok: boolean, code: string, message: string, data?: any }
//
// Codes:
//   - inserted            -> ok: true
//   - duplicate           -> ok: true
//   - not_project_wallet  -> ok: false
//   - tx_not_found        -> ok: false
//   - invalid_payload     -> ok: false
//   - db_error            -> ok: false
//   - rpc_error           -> ok: false
//
// Notes:
// - We do **not** price on the fly (amount_usd = null); `priced_at` is set to now for future fill.
// - We do **not** treat 'not_project_wallet' or 'tx_not_found' as HTTP errors; UX shows a neutral message.
//
// Env requirements:
//   - ETH_RPC_URL
//   - SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL
//   - Optional: NOWNODES_API_KEY (sent as `api-key` / `x-api-key` if present)

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ---------- Env ----------
const ETH_RPC_URL = process.env.ETH_RPC_URL as string | undefined
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL as string | undefined
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY as string | undefined
const NOWNODES_API_KEY = process.env.NOWNODES_API_KEY as string | undefined

// ---------- Types ----------
type RpcOk<T> = { ok: true; result: T }
type RpcErr = { ok: false; error: string; status?: number }
type RpcResp<T> = RpcOk<T> | RpcErr

type Tx = {
  blockNumber: string | null
  hash: string
  to: string | null
  value: string // hex
}

type Block = {
  timestamp: string // hex seconds since epoch
}

// ---------- Helpers ----------
const json = (body: any) =>
  NextResponse.json(body, { status: 200, headers: { 'cache-control': 'no-store' } })

const isEvmHash = (s: unknown): s is string =>
  typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s)

const strip0x = (s: string) => (s?.startsWith('0x') ? s.slice(2) : s)
const lowerNo0x = (s: string) => strip0x(String(s || '')).toLowerCase()

const hexToBigInt = (hex: string): bigint => {
  const clean = hex?.startsWith('0x') ? hex.slice(2) : hex
  return BigInt('0x' + (clean || '0'))
}

const hexToNumber = (hex: string): number => Number(hexToBigInt(hex))

const weiToEthString = (weiHexOrDec: string): string => {
  const wei = weiHexOrDec.startsWith('0x') ? hexToBigInt(weiHexOrDec) : BigInt(weiHexOrDec)
  const ether = wei / 10n ** 18n
  const remainder = wei % 10n ** 18n
  const fraction = remainder.toString().padStart(18, '0').replace(/0+$/, '')
  return fraction ? `${ether.toString()}.${fraction}` : ether.toString()
}

const nowIso = () => new Date().toISOString()

// ---------- Supabase ----------
function supa() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Missing Supabase env (URL/Service Role Key)')
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
}

async function findEthWalletIdByToAddress(addr: string): Promise<string | null> {
  const addressLower = addr.toLowerCase()
  const addressNo0x = lowerNo0x(addr)
  const sel = 'id,address,chain'

  // Try exact lowercased match with chain filter
  let q = supa().from('wallets').select(sel).eq('chain', 'eth').eq('address', addressLower).limit(1)
  let { data: w1, error: e1 } = await q
  if (!e1 && w1 && w1.length) return w1[0].id as string

  // Try address without 0x variants
  let { data: w2 } = await supa()
    .from('wallets')
    .select(sel)
    .eq('chain', 'eth')
    .or(`address.eq.${addressNo0x},address.eq.0x${addressNo0x}`)
    .limit(1)
  if (w2 && w2.length) return w2[0].id as string

  // Fallback: case-insensitive like match
  let { data: w3 } = await supa()
    .from('wallets')
    .select(sel)
    .eq('chain', 'eth')
    .ilike('address', `%${addressNo0x}%`)
    .limit(1)
  if (w3 && w3.length) return w3[0].id as string

  return null
}

async function isDuplicateTx(txHash: string): Promise<boolean> {
  const { data, error } = await supa()
    .from('contributions')
    .select('id')
    .eq('tx_hash', txHash)
    .limit(1)
  if (error) {
    // On DB error, assume not duplicate (let insert handle unique error)
    return false
  }
  return !!(data && data.length)
}

// ---------- RPC ----------
async function rpc<T = any>(method: string, params: any[]): Promise<RpcResp<T>> {
  if (!ETH_RPC_URL) return { ok: false, error: 'missing_eth_rpc_url' }
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (NOWNODES_API_KEY) {
      headers['api-key'] = NOWNODES_API_KEY
      headers['x-api-key'] = NOWNODES_API_KEY
    }
    const res = await fetch(ETH_RPC_URL, { method: 'POST', headers, body, cache: 'no-store' })
    if (!res.ok) return { ok: false, error: `rpc_http_${res.status}`, status: res.status }
    const j = (await res.json()) as { result?: any; error?: any }
    if (j?.error) return { ok: false, error: String(j.error?.message || 'rpc_error') }
    return { ok: true, result: j.result as T }
  } catch (e: any) {
    return { ok: false, error: e?.message || 'rpc_error' }
  }
}

const getTx = (hash: string) => rpc<Tx>('eth_getTransactionByHash', [hash])
const getBlockByNumber = (blockNumberHex: string) => rpc<Block>('eth_getBlockByNumber', [blockNumberHex, false])

// ---------- Route ----------
export async function POST(req: NextRequest) {
  try {
    const payload = await req.json().catch(() => ({}))
    const txHash = (payload?.txHash ?? payload?.hash ?? payload?.tx_hash ?? '').trim()
    const noteRaw = (payload?.note ?? payload?.message ?? '').toString().trim()

    if (!isEvmHash(txHash)) {
      return json({ ok: false, code: 'invalid_payload', message: 'Invalid transaction hash format.' })
    }

    // Check duplicate early (idempotency)
    if (await isDuplicateTx(txHash)) {
      return json({
        ok: true,
        code: 'duplicate',
        message: 'The transaction has already been recorded in our project before.',
        data: { txHash },
      })
    }

    // Fetch tx
    const txResp = await getTx(txHash)
    if (!txResp.ok) {
      // RPC hard error
      return json({ ok: false, code: 'rpc_error', message: 'An error occurred while fetching the transaction.' })
    }
    const tx = txResp.result
    if (!tx) {
      // Not found on chain
      return json({
        ok: false,
        code: 'tx_not_found',
        message: 'The hash of this transaction does not exist on the blockchain.',
        data: { txHash },
      })
    }

    // Must have 'to' and 'blockNumber'
    if (!tx.to) {
      return json({
        ok: false,
        code: 'not_project_wallet',
        message: 'The transaction is not directed to our project. The wallet address does not belong to this project.',
      })
    }

    const walletId = await findEthWalletIdByToAddress(tx.to)
    if (!walletId) {
      return json({
        ok: false,
        code: 'not_project_wallet',
        message: 'The transaction is not directed to our project. The wallet address does not belong to this project.',
      })
    }

    // Block time
    if (!tx.blockNumber) {
      // no block yet (pending?) — treat as not recorded
      return json({ ok: false, code: 'rpc_error', message: 'Transaction is not yet confirmed on-chain.' })
    }
    const blockResp = await getBlockByNumber(tx.blockNumber)
    if (!blockResp.ok || !blockResp.result?.timestamp) {
      return json({ ok: false, code: 'rpc_error', message: 'Unable to fetch block information.' })
    }
    const seconds = hexToNumber(blockResp.result.timestamp || '0x0')
    const blockTimeIso = new Date(seconds * 1000).toISOString()

    // Amount
    const amountEth = weiToEthString(tx.value || '0x0')

    // Insert into contributions
    const { error: insErr } = await supa()
      .from('contributions')
      .insert({
        wallet_id: walletId,
        tx_hash: txHash,
        amount: amountEth,
        amount_usd: null,                // Option B
        block_time: blockTimeIso,
        priced_at: nowIso(),             // Option B: mark pricing timestamp for later backfill
        note: noteRaw || null,
      })
      .select('*')
      .maybeSingle()

    if (insErr) {
      // If unique violation -> duplicate (idempotent)
      const msg = String(insErr.message || '')
      const code = (insErr as any).code || ''
      if (code === '23505' || /duplicate key|unique/i.test(msg)) {
        return json({
          ok: true,
          code: 'duplicate',
          message: 'The transaction has already been recorded in our project before.',
          data: { txHash },
        })
      }
      return json({ ok: false, code: 'db_error', message: 'Database write error.' })
    }

    return json({
      ok: true,
      code: 'inserted',
      message: 'The transaction was successfully recorded on our project.',
      data: {
        txHash,
        walletId,
        amount: amountEth,
        // block_time is already persisted; include for convenience if needed by the client:
        // block_time: blockTimeIso,
      },
    })
  } catch (e: any) {
    return json({ ok: false, code: 'invalid_payload', message: 'Invalid request payload.' })
  }
}

