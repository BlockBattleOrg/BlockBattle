// app/api/claim-ingest/eth/route.ts
// Claim-first ETH ingest route using UPSERT (ignoreDuplicates) to avoid false duplicate positives.
// Verifies a user-submitted tx hash against Ethereum RPC, ensures it's directed to one of our project wallets,
// and records it into `contributions` per the Supabase schema. Pricing is deferred (Option B).
//
// Table: contributions
//   - wallet_id (uuid, FK wallets.id)
//   - tx_hash (text, unique)  // stored lowercase for consistency
//   - amount (string)         // full-precision ETH as string
//   - amount_usd (numeric, nullable)  // Option B: leave NULL
//   - block_time (timestamptz)
//   - priced_at (timestamptz, nullable) // Option B: set NOW()
//   - note (text, nullable)
//
// Response contract (always HTTP 200):
//   { ok: boolean, code: string, message: string, data?: any }
//
// Codes & messages (exact spec):
//   inserted (ok:true)           -> "The transaction was successfully recorded on our project."
//   duplicate (ok:true)          -> "The transaction has already been recorded in our project before."
//   not_project_wallet (ok:false)-> "The transaction is not directed to our project. The wallet address does not belong to this project."
//   tx_not_found (ok:false)      -> "The hash of this transaction does not exist on the blockchain."
//   invalid_payload (ok:false)   -> generic invalid input message
//   db_error / rpc_error (false) -> generic system messages
//
// Env:
//   - ETH_RPC_URL
//   - SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL
//   - Optional: NOWNODES_API_KEY

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

  // Exact lowercased match (preferred)
  {
    const { data, error } = await supa()
      .from('wallets')
      .select(sel)
      .eq('chain', 'eth')
      .eq('address', addressLower)
      .limit(1)
    if (!error && data && data.length) return data[0].id as string
  }

  // Try without 0x variants
  {
    const { data } = await supa()
      .from('wallets')
      .select(sel)
      .eq('chain', 'eth')
      .or(`address.eq.${addressNo0x},address.eq.0x${addressNo0x}`)
      .limit(1)
    if (data && data.length) return data[0].id as string
  }

  // Fallback: case-insensitive search
  {
    const { data } = await supa()
      .from('wallets')
      .select(sel)
      .eq('chain', 'eth')
      .ilike('address', `%${addressNo0x}%`)
      .limit(1)
    if (data && data.length) return data[0].id as string
  }

  return null
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
    const txHashInput = (payload?.txHash ?? payload?.hash ?? payload?.tx_hash ?? '').trim()
    const noteRaw = (payload?.note ?? payload?.message ?? '').toString().trim()

    if (!isEvmHash(txHashInput)) {
      return json({ ok: false, code: 'invalid_payload', message: 'Invalid transaction hash format.' })
    }

    // Normalize tx hash to lowercase for storage/uniqueness consistency
    const txHash = txHashInput.toLowerCase()

    // Fetch tx from RPC
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

    // Must have destination and confirmed block
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

    if (!tx.blockNumber) {
      return json({ ok: false, code: 'rpc_error', message: 'Transaction is not yet confirmed on-chain.' })
    }

    const blockResp = await getBlockByNumber(tx.blockNumber)
    if (!blockResp.ok || !blockResp.result?.timestamp) {
      return json({ ok: false, code: 'rpc_error', message: 'Unable to fetch block information.' })
    }
    const seconds = hexToNumber(blockResp.result.timestamp || '0x0')
    const blockTimeIso = new Date(seconds * 1000).toISOString()

    const amountEth = weiToEthString(tx.value || '0x0')

    // UPSERT with ignoreDuplicates ensures deterministic duplicate detection.
    // If row already exists (same tx_hash), data will be [] with no error.
    const { data, error: upErr } = await supa()
      .from('contributions')
      .upsert(
        {
          wallet_id: walletId,
          tx_hash: txHash,     // stored lowercase
          amount: amountEth,
          amount_usd: null,    // Option B
          block_time: blockTimeIso,
          priced_at: nowIso(), // Option B
          note: noteRaw || null,
        },
        { onConflict: 'tx_hash', ignoreDuplicates: true }
      )
      .select('id') // will return [] if ignored due to duplicate
      .maybeSingle()

    if (upErr) {
      return json({ ok: false, code: 'db_error', message: 'Database write error.' })
    }

    if (!data) {
      // Upsert was ignored -> duplicate
      return json({
        ok: true,
        code: 'duplicate',
        message: 'The transaction has already been recorded in our project before.',
        data: { txHash },
      })
    }

    return json({
      ok: true,
      code: 'inserted',
      message: 'The transaction was successfully recorded on our project.',
      data: {
        txHash,
        walletId,
        amount: amountEth,
      },
    })
  } catch (e: any) {
    return json({ ok: false, code: 'invalid_payload', message: 'Invalid request payload.' })
  }
}

