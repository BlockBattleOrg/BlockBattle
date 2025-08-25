# BlockBattle.org — Roadmap & Status (TODO)

> This document tracks implementation status and next steps.  
> Source: initial TODO updated with current progress & recommendations.

**Legend**
- ✅ `[x]` done
- 🟡 `[~]` in progress / partially done
- ☐ `[ ]` not started

---

## Phase 0 — OPSEC and Standards
- ✅ Configure GitHub account for anonymity (`noreply` email, hide real email)
- ✅ Create `.gitignore`
- ✅ Create `.env.example` (without secrets)
- ✅ Add `README.md` (public overview)
- ✅ Add `SECURITY.md`
- ✅ Add `LICENSE`

## Phase 1 — Application Skeleton
- ✅ Next.js project (App Router, TypeScript, ESLint)
- ✅ TailwindCSS, Prettier, scripts for `lint` and `format`
- ✅ `/` page scaffolding
- ✅ GitHub → Vercel wired and deployed

## Phase 2 — Supabase Database + RLS + Seed
- ✅ Tables: `currencies`, `wallets`, `contributions`, `aggregates_daily`, `settings`
- ✅ RLS rules (public SELECT)
- ✅ Seed data (BTC, ETH, SOL, MATIC, AVAX)
- ✅ Public SELECT tested

---

## Phase 3 — Ingestion Service
- ✅ Serverless ingest routes per chain (protected by `x-cron-secret`), persisting `*_last_height` in `settings`:
  - **BTC, LTC, DOGE, ETH, OP, ARB, POL** (primary), **/ingest/matic** (legacy alias), **AVAX, DOT, ADA, ATOM, XRP, SOL, XLM, TRX**
- ✅ Standardized settings keys to `*_last_height`
- ✅ Primary RPC provider: **NowNodes** with header auth (`api-key`)
  - AVAX uses full path `…/ext/bc/C/rpc`
- ✅ Scheduling via **GitHub Actions** (per-chain workflows, 5–15 min)
- ❌ Vercel Cron (removed; paid add-on)
- ☐ Normalize on-chain amounts (`decimals`) and compute `amount_usd`
- ☐ Manual FX in `settings` (later automated via CoinGecko/proxy)
- ☐ Ingest telemetry (structured logs + basic alerts)

**Phase 3 acceptance**
- All routes return `{ ok: true, chain, height, saved: true }`
- `settings` has fresh `*_last_height` for every chain

---

## Phase 4 — Aggregation & Public API
- ☐ Daily snapshots (e.g., `chain_heights_daily` or “last height at UTC” KV)
- ☐ Aggregation cron job (rollup/upsert)
- ☐ Public, read-only API for UI (SSR/SWR friendly):
  - `/api/public/overview` — per-chain summary (height, delta, latency)
  - `/api/public/chain/:symbol` — chain details
  - (optional) keep `/api/public/rank` and `/api/public/meta` if useful
- ☐ Rate-limit + CORS on public routes

**Phase 4 acceptance**
- UI consumes **real** data only via public API
- Responses <300ms with CDN caching

---

## Phase 5 — UI Base (replace dummy → real data)
- 🟡 Current UI shows **dummy** data
- ☐ Wire UI to public API
- ☐ Ranking table + per-chain status (OK / stale / error)
- ☐ “Transparency” (last update, RPC provider)
- ☐ “Participate” modal (QR + address)
- ☐ Solid loading/empty/error states

**Phase 5 acceptance**
- Portal renders **live** data from ingestion
- Graceful empty/error UX

---

## Phase 6 — Community Blocks (Top 15)
- ☐ Add Recharts and `CommunityBlocks` component
- ☐ Fetch from public API (`/api/public/overview` or `/api/public/rank`)
- ☐ Treemap for Top 15 + legend and simple growth animation

---

## Phase 7 — Domain, Security, Performance
- ✅ Connect `blockbattle.org` to Vercel
- ☐ (Optional) Cloudflare proxy
- ☐ CORS hardening (allow only prod origin)
- ☐ Rate-limit on public routes (token bucket)
- ☐ Healthcheck endpoints and structured logging

---

## Phase 8 — Optional (Post-MVP)
- ☐ Automate FX per currency (CoinGecko or proxy)
- ☐ Token support (ERC-20 etc.)

## Phase 9 — Optional (Visualization)
- ☐ Tetris grid view
- ☐ Experimental Three.js 3D

---

## Tech-Debt & Cleanup
- 🟡 ENV cleanup
  - ✅ Keep: `NOWNODES_API_KEY`, `CRON_SECRET`, `SUPABASE_*`, and per-chain RPC vars
  - ✅ AVAX path includes `/ext/bc/C/rpc`
  - 🟡 **BTC** currently uses Blockstream/Mempool provider → keep `BTC_API_BASE`
  - ☐ Remove `/ingest/matic` alias once all schedulers call `/ingest/pol`
- ☐ Uniform error shape across all ingest routes
- ☐ `/api/health` endpoint for liveness
- ☐ Basic alerting for failed schedules



