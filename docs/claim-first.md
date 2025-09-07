Claim-First Flow: Design & Implementation

This document describes the claim-first contribution flow and the minimal set of new routes that make it robust, cost-effective, and transparent. Legacy scanning jobs stay in place but are reduced to “light enrichment”.

Why claim-first?

Fewer RPC calls: Only verify transactions that users actively claim.

Immediate feedback: User gets a clear result (recorded / pending / not found).

Operational stability: Daily jobs become “light” (enrichment + thin scans).

Minimal schema change: Only one optional field note added to contributions.

Components
1) Public endpoint: /api/claim

Validates { chain, tx, hcaptchaToken?, message? }.

Normalizes EVM hashes to 0x + lowercase.

Rate-limits and enforces hCaptcha (unless bypass header).

Pre-check in DB (exact match; for EVM, try variants).

If not in DB → calls chain-specific claim-ingest route.

Returns:

ok:true, alreadyRecorded:true if found in DB

ok:true, inserted:{…} if verified and inserted

ok:false, error: 'tx_not_found' | 'tx_pending' | … otherwise

If message (≤ 280 chars) is provided and the insert is fresh, API sets contributions.note once (no overwrite).

2) New claim-ingest routes

Located under a new namespace:
app/api/claim-ingest/<chain>/route.ts

Responsibilities:

Canonicalize tx hash/signature.

Verify on chain (e.g., EVM: eth_getTransactionReceipt; SOL: getSignatureStatuses).

Insert into DB if confirmed.

Idempotent: SELECT first, then INSERT; catch duplicate error → alreadyRecorded:true.

Why separate?
Legacy ingest routes under app/api/ingest/contrib/<chain> remain for daily cron jobs.
New claim-ingest routes are minimal, single-tx, and user-facing.

3) Daily job (light mode)

Enrich existing contributions (confirmations, amounts, addresses).

Optionally thin scan last N blocks for our addresses only.

Strong logging and strict rate-limit.

Directory layout

app/
api/
claim/route.ts # public claim endpoint
claim-ingest/
eth/route.ts # new: single-tx EVM verify + insert
arb/route.ts
op/route.ts
pol/route.ts
avax/route.ts
bsc/route.ts
sol/route.ts
...
ingest/
contrib/
<legacy>/route.ts # legacy scan endpoints
docs/
claim-first.md
supabase/
migrations/
20250907_add_contribution_note.sql

API contracts
POST /api/claim

Body:
{ "chain": "eth", "tx": "0x...", "hcaptchaToken": "...", "message": "optional note" }

Response (new insert):
{ "ok": true, "chain": "eth", "tx": "0x...", "inserted": { "id": 123 }, "alreadyRecorded": false }

Response (already recorded):
{ "ok": true, "chain": "eth", "tx": "0x...", "inserted": null, "alreadyRecorded": true }

Response (pending / not found):
{ "ok": false, "chain": "eth", "tx": "0x...", "error": "tx_pending" }
{ "ok": false, "chain": "eth", "tx": "0x...", "error": "tx_not_found" }

POST /api/claim-ingest/<chain>?tx=...

Guarded by x-cron-secret.

Verifies tx on chain and inserts if confirmed.

Response:
{ "ok": true, "inserted": { "id": 123 }, "alreadyRecorded": false }
or
{ "ok": false, "error": "tx_not_found" }

Canonicalization rules

EVM: 0x + lowercase 64-hex.

SOL: base58 signature as is.

Others: chain-native format.

All new inserts are canonical. Claim pre-check tolerates legacy variants.

Security & abuse controls

hCaptcha (UI + API).

IP rate-limit (local + global).

Secret headers on claim-ingest routes.

note only set on first insert.

Deployment steps

Apply migration (note column).

Ensure env vars:

CRON_SECRET, CLAIM_BYPASS_SECRET

RPC keys (NOWNODES_API_KEY, <CHAIN>_RPC_URL)

hCaptcha keys (NEXT_PUBLIC_HCAPTCHA_SITE_KEY, HCAPTCHA_SECRET)

Deploy.

Smoke tests:

Claim UI with ETH/SOL

Curl POST /api/claim with bypass

Direct POST /api/claim-ingest/eth with x-cron-secret

Future enhancements

Add unique index on contributions(tx_hash) after canonicalization.

Allow editing note with wallet proof.

Return explorerUrl in API response.

Multi-language UI.
