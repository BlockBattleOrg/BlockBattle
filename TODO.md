# BlockBattle.org — Roadmap & Status (TODO)

> Source of truth for implementation status and next steps.  
> Legend: ✅ `[x]` done · 🟡 `[~]` in progress · ☐ `[ ]` not started

---

## Phase 0 — OPSEC and Standards
- ✅ `[x]` GitHub noreply identity; hidden real email
- ✅ `[x]` `.gitignore`, `README.md`, `SECURITY.md`, `LICENSE`
- ✅ `[x]` `.env.example` (no secrets committed)

## Phase 1 — Application Skeleton
- ✅ `[x]` Next.js (App Router, TypeScript, ESLint, Tailwind)
- ✅ `[x]` Core pages and layout
- ✅ `[x]` GitHub → Vercel CI/CD (production domain wired)

## Phase 2 — Database (Supabase) & Security
- ✅ `[x]` Tables: `currencies`, `wallets`, `contributions`, `aggregates_daily`, `settings`, `heights_daily`
- ✅ `[x]` RLS enabled (read-only where appropriate)
- ✅ `[x]` Security review clean (RLS on `heights_daily`)
- ✅ `[x]` Seed base currencies & wallets (APIs resilient to missing `currency_id`)

## Phase 3 — Ingestion (Chain Heights & Contributions)
- ✅ `[x]` Height ingesters (protected via `x-cron-secret`) using NowNodes:
  **BTC, LTC, DOGE, ETH, OP, ARB, POL (legacy alias `/ingest/matic`), AVAX, DOT, ATOM, XRP, SOL, XLM, TRX, BSC**
- ✅ `[x]` Height markers in `settings` as `<CHAIN>_last_height`
- ✅ `[x]` GitHub Actions schedules (hourly, staggered)
- ✅ `[x]` Native contribution ingest (`<chain>_contrib_last_scanned` markers)
- ✅ `[x]` FX batch sync (CoinGecko) → fills `contributions.amount_usd` (admin route + cron)
  - ✅ `[x]` Fixed mapping **MATIC ⇢ POL**
  - ✅ `[x]` Does not rely on `wallets.symbol` (uses `currencies`)
- ☐ `[ ]` Telemetry (structured logs) & basic alerting on failures

**Acceptance (P3):** all ingest endpoints return `{ ok: true }`; `settings` markers update consistently.

---

## Phase 4 — Aggregation & Public API
- ✅ `[x]` `/api/public/overview` (heights summary)
  - ✅ `[x]` based on `heights_daily`
  - ✅ `[x]` alias display: `POL→MATIC`, `BSC→BNB`
  - ✅ `[x]` status thresholds: **OK ≤ 6h**, **STALE 6–24h**, **ISSUE > 24h**
- ✅ `[x]` `/api/public/wallets` (donation address by `wallets.chain`)
- ✅ `[x]` Public leaderboard (native + USD):
  - ✅ `[x]` `?order=usd` + `usd_total`
  - ✅ `[x]` compat route `/api/public/contributions/leaderboard`
  - ✅ `[x]` server env: service-role preferred; anon fallback
- ✅ `[x]` Recent contributions include `amount_usd`
- ✅ `[x]` APIs marked **dynamic** / `no-store`
- ✅ `[x]` Rollups: heights daily @00:05 UTC; contributions every 2h
- 🟡 `[~]` Stale/latency metadata in `/api/public/overview`
- ☐ `[ ]` CORS allow-list + lightweight rate limiting

**Acceptance (P4):** UI consumes real data; USD totals available; responses remain fresh and fast.

---

## Phase 5 — UI (Live Data)
- ✅ `[x]` Chain Heights table (live)
- ✅ `[x]` **Participate** modal with QR (wired to `/api/public/wallets?chain=...`)
  - ✅ `[x]` display-symbol → `wallets.chain` mapping (e.g., `MATIC → pol`, `BNB → bsc`)
  - ✅ `[x]` QR generation and copy-to-clipboard
- ✅ `[x]` Contributions panel: clear headings (“Totals by chain” / “Recent”), USD columns, explorer links
- ✅ `[x]` Chain logos (SVG) in `public/logos/crypto/`
- ✅ `[x]` Native amounts with full precision
- ✅ `[x]` Status badges (OK/STALE/ISSUE) from API metadata
- ☐ `[ ]` Polish empty/loading/error states

---

## Phase 6 — Community Blocks (Top 15) — optional
- ☐ `[ ]]` Treemap (“battle view”) using Recharts; fed by overview/rollups

---

## Phase 7 — Domain, Security, Performance
- ✅ `[x]` `blockbattle.org` live on Vercel
- ☐ `[ ]` Optional Cloudflare proxy
- ☐ `[ ]` CORS allow-list → production origin only
- ☐ `[ ]` Token-bucket rate limiting on public APIs
- ✅ `[x]` `/api/health`
- ☐ `[ ]` Centralized structured logging

---

## Phase 8 — Post-MVP
- 🟡 `[~]` FX real-time on insert (keep batch as fallback)
- ☐ `[ ]` Token donations (ERC-20 `Transfer` logs on project wallets)

---

## Phase 9 — Exploratory Visualizations
- ☐ `[ ]` Tetris grid view
- ☐ `[ ]` Three.js 3D prototype

---

## Tech Debt & Cleanup
- 🟡 `[~]` ENV cleanup
  - ✅ `[x]` Keep: `NOWNODES_API_KEY`, `CRON_SECRET`, `SUPABASE_*`, per-chain `*_RPC_URL`
  - ✅ `[x]` AVAX RPC must include `/ext/bc/C/rpc`
  - 🟡 `[~]` BTC via Blockstream/Mempool → `BTC_API_BASE`
  - 🟡 `[~]` Remove legacy groups (`*_RPC_URLS`, old DOGE/LTC tunables) when unused
- 🟡 `[~]` Keep `/ingest/matic` alias temporarily; remove once all schedulers use `/ingest/pol`
- ☐ `[ ]` Uniform error payloads across ingest routes
- ☐ `[ ]` Unit tests for helpers; smoke tests for public APIs

---

## Known Aliases (display → wallets.chain)
- `MATIC` → `pol`
- `BNB` → `bsc`
- (add more as needed)

---

## Immediate Next Steps
1. FX real-time on insert (retain batch as fallback).  
2. CORS + rate limiting on public routes.  
3. Add stale/latency metadata to `/api/public/overview` and surface in UI.  
4. Polish loading/empty/error states on key components.

---

### ENV (production)
- `NOWNODES_API_KEY`, `CRON_SECRET`  
- `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`  
- Per-chain RPCs: `ETH_RPC_URL`, `OP_RPC_URL`, `ARB_RPC_URL`, `POL_RPC_URL`, `AVAX_RPC_URL`,  
  `DOT_RPC_URL`, `ATOM_RPC_URL`, `XRP_RPC_URL`, `SOL_RPC_URL`, `XLM_HORIZON_URL`, `TRX_RPC_URL`, `BSC_RPC_URL`  
- BTC: `BTC_API_BASE` (Blockstream/Mempool)

---

## Changelog (2025-08-31)
- **Overview API:** switched to `heights_daily`; alias display `POL→MATIC`, `BSC→BNB`; status thresholds 6h/24h.  
- **Wallets API:** called with `?chain=<wallets.chain>`; frontend maps from `currencies.symbol`.  
- **Participate modal:** restored and wired; QR + copy.  
- **UI:** Chain Heights with SVG logos, Participate actions, and status badges.

