# BlockBattle.org — Roadmap & Status (TODO)

> Source of truth for implementation status and next steps.  
> Legend: ✅ `[x]` done · 🟡 `[~]` in progress · ☐ `[ ]` not started

---

## Phase 0 — OPSEC and Standards
- ✅ `[x]` GitHub noreply identity; hidden real email
- ✅ `[x]` `.gitignore`, `README.md`, `SECURITY.md`, `LICENSE`
- ✅ `[x]` `.env.example` (no secrets) :contentReference[oaicite:0]{index=0}

## Phase 1 — Application Skeleton
- ✅ `[x]` Next.js (App Router, TS, ESLint, Tailwind)
- ✅ `[x]` Basic pages and layout
- ✅ `[x]` GitHub → Vercel pipeline (production domain wired) :contentReference[oaicite:1]{index=1}

## Phase 2 — Database (Supabase) & Security
- ✅ `[x]` Tables: `currencies`, `wallets`, `contributions`, `aggregates_daily`, `settings`, `heights_daily`
- ✅ `[x]` RLS enabled (read-only where needed)
- ✅ `[x]` Security Advisor clean (RLS on `heights_daily`)
- ✅ `[x]` Seeded base currencies & wallets (API tolerant to missing `currency_id`) :contentReference[oaicite:2]{index=2}

## Phase 3 — Ingestion (Chain Heights & Contributions)
- ✅ `[x]` Heights ingest routes (protected by `x-cron-secret`) using **NowNodes**:
  **BTC, LTC, DOGE, ETH, OP, ARB, POL (alias `/ingest/matic`), AVAX, DOT, ATOM, XRP, SOL, XLM, TRX, BSC**:contentReference[oaicite:3]{index=3}
- ✅ `[x]` Standardized height markers in `settings` as `<CHAIN>_last_height`:contentReference[oaicite:4]{index=4}
- ✅ `[x]` GitHub Actions schedules for height ingests (optimized: hourly, staggered):contentReference[oaicite:5]{index=5}
- ✅ `[x]` Native **contribution ingest**:
  - ✅ `[x]` POL (EVM native)
  - ✅ `[x]` ETH (EVM native)
  - ✅ `[x]` ATOM (Cosmos LCD/RPC via NowNodes, Supabase integration)
  - ✅ `[x]` AVAX (EVM native, Supabase integration)
  - ✅ `[x]` DOT (proxy/core setup, Supabase integration)
  - ✅ `[x]` OP (EVM native)
  - ✅ `[x]` ARB (EVM native)
  - ✅ `[x]` All chains maintain `<chain>_contrib_last_scanned` markers in `settings`
  - ✅ `[x]` GitHub Actions contrib ingests (optimized: every 3h, staggered):contentReference[oaicite:6]{index=6}
- ✅ `[x]` Normalize `amount_usd` (FX integration) and write to `contributions.amount_usd`:contentReference[oaicite:7]{index=7}
- ☐ `[ ]` Telemetry (structured logs) & basic alerts on failure

**Notes (Phase 3):** Ingestion routes remain; **DOT & ATOM nisu u Community Blocks (UI)**.

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
- ✅ `[x]` CORS allow-list + lightweight rate limiting on public routes :contentReference[oaicite:8]{index=8}

**Phase 4 acceptance:** UI reads real data via public API; responses are fresh and fast. :contentReference[oaicite:9]{index=9}

---

## Phase 5 — UI (Live Data)
- ✅ `[x]` Heights table uses live values
- ✅ `[x]` “Participate” modal with QR (dynamic import of `qrcode`)
- ✅ `[x]` Contributions panel (Leaderboard + Recent)
- ✅ `[x]` Explorer links across chains (EVM, **BTC, LTC, DOGE, XRP, SOL, XLM** …) on Recent contributions
- ✅ `[x]` Amount rendering with full native precision per chain (no confusing “0”):contentReference[oaicite:10]{index=10}
- ✅ `[x]` `/claim` page (form for claiming contributions)
- ✅ `[x]` **Note rendering**: shows `note` from Supabase `contributions` in Recent list
- ✅ `[x]` **Claim button** in main table opens `/claim` page
- ✅ `[x]` **Removed per-chain status badges (OK/STALE/ERR)** — background processing flow changed; badges are no longer meaningful for contribution/claim
- ☐ `[ ]` Empty/loading/error states polish across the app

---

## Phase 6 — Community Blocks (Top 15)
- ✅ `[x]` **Removed DOT & ATOM from Community Blocks** (UI only; ingestion remains available)
- ✅ `[x]` Treemap (“battle” view) using Recharts; fed by overview/rollups

---

## Phase 7 — Domain, Security, Perf
- ✅ `[x]` `blockbattle.org` live on Vercel
- ☐ `[ ]` Optional Cloudflare proxy
- ✅ `[x]` CORS allow-list → production origin only
- ✅ `[x]` Token-bucket rate limit on public API
- ✅ `[x]` `/api/health` implemented
- ☐ `[ ]` Centralized structured logging :contentReference[oaicite:11]{index=11}

---

## Phase 8 — Post-MVP
- ✅ `[x]` FX aggregator (CoinGecko/proxy) → fill `amount_usd` at insert time

---

## Phase 9 — Exploratory Visualizations
- ✅ `[x]` Tetris grid view
- ☐ `[ ]` Three.js 3D prototype :contentReference[oaicite:12]{index=12}

---

## Tech-Debt & Cleanup
- 🟡 `[~]` ENV cleanup
  - ✅ `[x]` Keep: `NOWNODES_API_KEY`, `CRON_SECRET`, `SUPABASE_*`, per-chain `*_RPC_URL`
  - ✅ `[x]` AVAX RPC must include `/ext/bc/C/rpc`
  - 🟡 `[~]` BTC uses Blockstream/Mempool → keep `BTC_API_BASE`
  - 🟡 `[~]` Remove legacy groups (`*_RPC_URLS`, old DOGE/LTC tunables) once unused
  - 🟡 `[~]` Keep `/ingest/matic` alias temporarily; remove when all schedulers call `/ingest/pol`
- ☐ `[ ]` Uniform error payload across ingest routes
- ☐ `[ ]` Unit tests for helpers; smoke tests for APIs :contentReference[oaicite:13]{index=13}

---

## Immediate Next Steps
1. ✅ **Cron optimization across all chains** (hourly heights, 3h contrib, staggered).  
2. ✅ **Rollups**: heights daily @00:05, contributions every 2h @:05.  
3. **UI polish**: loading/empty/error states. :contentReference[oaicite:14]{index=14}

---

### ENV (production)
- `NOWNODES_API_KEY`, `CRON_SECRET`
- `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Per-chain RPCs: `ETH_RPC_URL`, `OP_RPC_URL`, `ARB_RPC_URL`, `POL_RPC_URL`, `AVAX_RPC_URL`,  
  `DOT_RPC_URL`, `ATOM_RPC_URL`, `XRP_RPC_URL`, `SOL_RPC_URL`, `XLM_HORIZON_URL`, `TRX_RPC_URL`, `BSC_RPC_URL`
- BTC: `BTC_API_BASE` (Blockstream/Mempool)
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (for rate limiting) :contentReference[oaicite:15]{index=15}

---

## Changelog (today)
- **UI:** Removed per-chain status badges (OK/STALE/ERR) — no longer aligned with the final flow.  
- **Data:** FX aggregator at insert time for `amount_usd`.  
- **UI:** Tetris grid (treemap) shipped.  
- **Prev:** Claim button in main table; explorer links across chains; `note` rendering; workflows cleaned of DOT/ATOM.  

