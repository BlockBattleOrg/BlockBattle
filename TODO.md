# BlockBattle.org — Development TODO

> **Note:** This is a temporary development document.  
> It will be removed or archived when the project is completed.

## Phase 0 — OPSEC and Standards
- [x] Configure GitHub account for anonymity (`noreply` email, hide real email)
- [x] Create `.gitignore`
- [x] Create `.env.example` (without secrets)
- [x] Add `README.md` (public overview)
- [x] Add `SECURITY.md`
- [x] Add `LICENSE`

## Phase 1 — Application Skeleton
- [x] Create Next.js project (App Router, TypeScript, ESLint)
- [x] Add TailwindCSS, Prettier, scripts for `lint` and `format`
- [x] Add `/` page with "It works"
- [x] Connect GitHub → Vercel and deploy

## Phase 2 — Supabase Database + RLS + Seed
- [ ] Create tables: `currencies`, `wallets`, `contributions`, `aggregates_daily`, `settings`
- [ ] Set RLS rules (public SELECT)
- [ ] Insert seed data (BTC, ETH, SOL, MATIC, AVAX)
- [ ] Test public SELECT

## Phase 3 — Ingestion Service
- [ ] Create serverless ingestion functions per chain (BTC, ETH, SOL, MATIC, AVAX)
- [ ] Normalize amounts (`decimals`) and calculate `amount_usd`
- [ ] Manually set daily exchange rates in `settings` (CoinGecko later)
- [ ] Configure Vercel Cron (15–30 min)

## Phase 4 — Aggregation + Public API
- [ ] Create daily upsert into `aggregates_daily`
- [ ] Create materialized view / RPC for Top 15
- [ ] Implement public API routes:
  - [ ] `/api/public/rank` (Top 15)
  - [ ] `/api/public/meta` (countdown meta)
  - [ ] `/api/public/wallets` (public wallet addresses)

## Phase 5 — UI Base
- [ ] Layout, navigation, footer
- [ ] Hero + CTA (“Participate”)
- [ ] Ranking table (symbol, name, USD total, #tx, participate button)
- [ ] “Participate” modal (QR code + address)
- [ ] Countdown component
- [ ] Transparency section (repo link, ingestion logic description, address list)

## Phase 6 — Community Blocks (Top 15)
- [ ] Add Recharts and `CommunityBlocks` component
- [ ] Fetch data from `/api/public/rank`
- [ ] Implement treemap for all 15 currencies
- [ ] Add growth animation and legend

## Phase 7 — Domain, Security, and Performance
- [ ] Connect `blockbattle.org` to Vercel
- [ ] (Optional) Setup Cloudflare proxy
- [ ] Set CORS (only production domain)
- [ ] Add rate-limit to public routes
- [ ] Implement healthcheck and logging

## Phase 8 — Optional (Post-MVP)
- [ ] Automate FX per currency (CoinGecko)
- [ ] Add support for tokens (ERC-20, etc.)

## Phase 9 — Optional (Visualization)
- [ ] Implement Tetris grid view
- [ ] Experimental 3D version (Three.js)
