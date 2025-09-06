# BlockBattle.org — Roadmap & Status (TODO)

> Source of truth for implementation status and next steps.  
> Legend: ✅ `[x]` done · 🟡 `[~]` in progress · ☐ `[ ]` not started

---

## Phase 0 — OPSEC and Standards
- ✅ `[x]` GitHub noreply identity; hidden real email
- ✅ `[x]` `.gitignore`, `README.md`, `SECURITY.md`, `LICENSE`
- ✅ `[x]` `.env.example` (no secrets)

## Phase 1 — Application Skeleton
- ✅ `[x]` Next.js (App Router, TS, ESLint, Tailwind)
- ✅ `[x]` Basic pages and layout
- ✅ `[x]` GitHub → Vercel pipeline (production domain wired)

## Phase 2 — Database (Supabase) & Security
- ✅ `[x]` Tables: `currencies`, `wallets`, `contributions`, `aggregates_daily`, `settings`, `heights_daily`
- ✅ `[x]` RLS enabled (read-only where needed)
- ✅ `[x]` Security Advisor clean (RLS on `heights_daily`)
- ✅ `[x]` Seeded base currencies & wallets (API tolerant to missing `currency_id`)

## Phase 3 — Ingestion (Chain Heights & Contributions)
- ✅ `[x]` Heights ingest routes (protected by `x-cron-secret`) using **NowNodes**:
  **BTC, LTC, DOGE, ETH, OP, ARB, POL (alias `/ingest/matic`), AVAX, DOT, ATOM, XRP, SOL, XLM, TRX, BSC**
- ✅ `[x]` Standardized height markers in `settings` as `<CHAIN>_last_height`
- ✅ `[x]` GitHub Actions schedules for height ingests (optimized: hourly, staggered)
- ✅ `[x]` Native **contribution ingest**:
  - ✅ `[x]` POL (EVM native)
  - ✅ `[x]` ETH (EVM native)
  - ✅ `[x]` ATOM (Cosmos LCD/RPC via NowNodes, Supabase integration)
  - ✅ `[x]` AVAX (EVM native, Supabase integration)
  - ✅ `[x]` DOT (proxy/core setup, Supabase integration)
  - ✅ `[x]` OP (EVM native)
  - ✅ `[x]` ARB (EVM native)
  - ✅ `[x]` All chains maintain `<chain>_contrib_last_scanned` markers in `settings`
  - ✅ `[x]` GitHub Actions contrib ingests (optimized: every 3h, staggered)
- ✅ `[x]` Normalize `amount_usd` (FX integration) and write to `contributions.amount_usd`
- ☐ `[ ]` Telemetry (structured logs) & basic alerts on failure

**Phase 3 acceptance:** All ingest routes return `{ ok: true, ... }`, and `settings` markers advance per run.

---

## Phase 4 — Aggregation & Public API
- ✅ `[x]` `/api/public/overview` (heights summary consumed by homepage)
- ✅ `[x]` `/api/public/wallets` (fetch donation address by chain)
- ✅ `[x]` `/api/public/contributions/leaderboard`
- ✅ `[x]` `/api/public/contributions/recent`
- ✅ `[x]` `/api/claim` (public endpoint to claim contribution by tx hash, with Supabase pre-check for idempotency)
- ✅ `[x]` APIs marked **dynamic** (`no-store`) to avoid stale data
- ✅ `[x]` Daily rollups (`/api/admin/snapshot-heights` + cron at 00:05 UTC) for contributions & heights
- ✅ `[x]` Contributions rollup job adjusted to 2-hourly schedule
- 🟡 `[~]` Stale/latency metadata in `/api/public/overview` (endpoint works, metadata not yet added)
- ✅ `[x]` CORS allow-list + lightweight rate limiting on public routes

**Phase 4 acceptance:** UI reads real data via public API; responses are fresh and fast.

---

## Phase 5 — UI (Live Data)
- ✅ `[x]` Heights table uses live values
- ✅ `[x]` “Participate” modal with QR (dynamic import of `qrcode`)
- ✅ `[x]` Contributions panel (Leaderboard + Recent)
- ✅ `[x]` Explorer links (Etherscan/Polygonscan) for recent tx
- ✅ `[x]` Amount rendering with full native precision per chain (no confusing “0”)
- ✅ `[x]` `/claim` page (form for claiming contributions)
- ☐ `[ ]` Status badges per chain (OK/STALE/ERR) sourced from API metadata
- ☐ `[ ]` Empty/loading/error states polish across the app

---

## Phase 6 — Community Blocks (Top 15) — optional
- ☐ `[ ]` Treemap (“battle” view) using Recharts; fed by overview/rollups

---

## Phase 7 — Domain, Security, Perf
- ✅ `[x]` `blockbattle.org` live on Vercel
- ☐ `[ ]` Optional Cloudflare proxy
- ✅ `[x]` CORS allow-list → production origin only
- ✅ `[x]` Token-bucket rate limit on public API
- ✅ `[x]` `/api/health` implemented
- ☐ `[ ]` Centralized structured logging

---

## Phase 8 — Post-MVP
- ☐ `[ ]` FX aggregator (CoinGecko/proxy) → fill `amount_usd` at insert time
- ☐ `[ ]` Token donations (ERC-20 `Transfer` logs to project wallets)

---

## Phase 9 — Exploratory Visualizations
- ☐ `[ ]` Tetris grid view
- ☐ `[ ]` Three.js 3D prototype

---

## Tech-Debt & Cleanup
- 🟡 `[~]` ENV cleanup
  - ✅ `[x]` Keep: `NOWNODES_API_KEY`, `CRON_SECRET`, `SUPABASE_*`, per-chain `*_RPC_URL`
  - ✅ `[x]` AVAX RPC must include `/ext/bc/C/rpc`
  - 🟡 `[~]` BTC uses Blockstream/Mempool → keep `BTC_API_BASE`
  - 🟡 `[~]` Remove legacy groups (`*_RPC_URLS`, old DOGE/LTC tunables) once unused
  - 🟡 `[~]` Keep `/ingest/matic` alias temporarily; remove when all schedulers call `/ingest/pol`
- ☐ `[ ]` Uniform error payload across ingest routes
- ☐ `[ ]` Unit tests for helpers; smoke tests for APIs

---

## Immediate Next Steps
1. ✅ **Cron optimization across all chains** (hourly heights, 3h contrib, staggered).  
2. ✅ **Rollups**: heights daily @00:05, contributions every 2h @:05.  
3. **UI polish**: status badges (OK/STALE/ERR), loading/empty states.

---

### ENV (production)
- `NOWNODES_API_KEY`, `CRON_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Per-chain RPCs: `ETH_RPC_URL`, `OP_RPC_URL`, `ARB_RPC_URL`, `POL_RPC_URL`, `AVAX_RPC_URL`,  
  `DOT_RPC_URL`, `ATOM_RPC_URL`, `XRP_RPC_URL`, `SOL_RPC_URL`, `XLM_HORIZON_URL`, `TRX_RPC_URL`, `BSC_RPC_URL`
- BTC: `BTC_API_BASE` (Blockstream/Mempool)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (for rate limiting)

---

## Changelog (today)
- All ingest workflows reduced to hourly (heights) and 3-hourly (contrib), staggered.  
- Rollup contributions job changed to 2-hourly.  
- Snapshot-heights confirmed daily at 00:05 UTC.  
- DOT, OP, ARB contrib routes + cron workflows added.  
- ATOM/AVAX contrib routes aligned to proxy pattern (core ingest).  
- All 16 chain ingest routes confirmed green (including BSC).  
- Public contributions API: dynamic `no-store` + correct FK joins.  
- UI: explorer links + full-precision amounts.  
- Security: RLS enabled on `heights_daily` (advisor clean).  
- ✅ CORS allow-list + rate limiting on public routes implemented.  
- ✅ Normalize `amount_usd` implemented.  
- ✅ Production-only CORS allow-list + token-bucket RL enabled.  
- ✅ New `/api/claim` endpoint with Supabase pre-check for existing tx.  
- ✅ New `/claim` UI form for public contribution claiming.  

