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
  **BTC, LTC, DOGE, ETH, OP, ARB, POL (alias `/ingest/matic`), AVAX, XRP, SOL, XLM, TRX, BSC**  
  (DOT/ATOM removed)
- ✅ `[x]` Standardized height markers in `settings` as `<CHAIN>_last_height`
- ✅ `[x]` GitHub Actions schedules for height ingests (optimized: hourly, staggered)
- ✅ `[x]` Native **contribution ingest** (all supported chains)
- ✅ `[x]` All chains maintain `<chain>_contrib_last_scanned` markers in `settings`
- ✅ `[x]` GitHub Actions contrib ingests (optimized: every 3h, staggered)
- ✅ `[x]` Normalize `amount_usd` (FX integration) and write to `contributions.amount_usd`
- ☐ `[ ]` Telemetry (structured logs) & basic alerts on failure

---

## Phase 4 — Aggregation & Public API
- ✅ `[x]` `/api/public/overview`
- ✅ `[x]` `/api/public/wallets`
- ✅ `[x]` `/api/public/contributions/leaderboard`
- ✅ `[x]` `/api/public/contributions/recent`
- ✅ `[x]` `/api/claim`
- ✅ `[x]` APIs marked **dynamic**
- ✅ `[x]` Daily rollups (`/api/admin/snapshot-heights`)
- ✅ `[x]` Contributions rollup job adjusted to 2-hourly schedule
- ✅ `[x]` New `/api/admin/rollup-contributions-daily` (all-time + from/to window) → rebuilds `aggregates_daily`
- 🟡 `[~]` Stale/latency metadata in `/api/public/overview`
- ✅ `[x]` CORS allow-list + lightweight rate limiting

---

## Phase 5 — UI (Live Data)
- ✅ `[x]` Heights table (live)
- ✅ `[x]` “Participate” modal with QR
- ✅ `[x]` Contributions panel (Leaderboard + Recent, explorer links, notes)
- ✅ `[x]` Amount rendering with full native precision
- ✅ `[x]` `/claim` page
- ❌ `[ ]` Status badges per chain (dropped — no longer needed for contrib/claim UX)
- 🟡 `[~]` Empty/loading/error states polish

---

## Phase 6 — Community Blocks (Visuals)
- ✅ `[x]` Treemap Top-5 (All-time) implemented via Recharts, mounted below “Totals by chain”
- ✅ `[x]` Integrated with rollup data (`aggregates_daily`)
- ✅ `[x]` Color-coding aligned with Community Blocks legend
- 🟡 `[~]` Visual polish (hover effects, sizing tweaks, playful layout for crypto audience)

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
- ✅ `[x]` FX aggregator (CoinGecko/proxy) in workflows → reprices `contributions.amount_usd`
- ✅ `[x]` FX reprice integrated into `aggregates_daily`
- ☐ `[ ]` Token donations (ERC-20 `Transfer` logs)

---

## Phase 9 — Exploratory Visualizations
- ✅ `[x]` Treemap (Top-5 All-time)
- ☐ `[ ]` Tetris grid view (prototype)
- ☐ `[ ]` Three.js 3D prototype (Level 1 MVP scene exists, not public yet)

---

## Tech-Debt & Cleanup
- 🟡 `[~]` ENV cleanup
- ☐ `[ ]` Uniform error payloads across ingest routes
- ☐ `[ ]` Unit tests for helpers; smoke tests for APIs

---

## Immediate Next Steps
1. UI polish: loading/empty states, minor error feedback.  
2. Visual/UI refresh: more playful crypto-style look (colors, logo, branding).  
3. Explore optional prototypes (Tetris grid, 3D) for engagement.

---

