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
- ✅ `[x]` GitHub Actions schedules for height ingests (hourly, staggered)
- ✅ `[x]` Native **contribution ingest** (sa `<chain>_contrib_last_scanned` markerima)
- ✅ `[x]` **FX batch sync (CoinGecko)** → popunjava `contributions.amount_usd` (admin ruta + cron)
  - ✅ `[x]` Ispravljen mapping **MATIC ⇢ POL**
  - ✅ `[x]` Ne ovisi o `wallets.symbol` (koristi `currencies`)
- ☐ `[ ]` Telemetry (structured logs) & basic alerts on failure

**Acceptance (P3):** svi ingest endpointi vraćaju `{ ok: true }`, markeri u `settings` se ažuriraju.

---

## Phase 4 — Aggregation & Public API
- ✅ `[x]` `/api/public/overview` (heights summary)
- ✅ `[x]` `/api/public/wallets` (donation address by chain)
- ✅ `[x]` **Public leaderboard** (native + USD):
  - ✅ `[x]` `?order=usd` + polje `usd_total`
  - ✅ `[x]` Compat ruta: `/api/public/contributions/leaderboard`
  - ✅ `[x]` Server-side env: service-role preferiran; anon fallback
- ✅ `[x]` **Recent contributions** uključuje `amount_usd`
- ✅ `[x]` API-ji označeni **dynamic** (`no-store`)
- ✅ `[x]` Rollup: heights dnevno @00:05 UTC; contributions svaka 2h
- 🟡 `[~]` Stale/latency metadata u `/api/public/overview`
- ☐ `[ ]` CORS allow-list + lightweight rate limiting

**Acceptance (P4):** UI čita stvarne podatke; dostupni USD total(i); responsi svježi i brzi.

---

## Phase 5 — UI (Live Data)
- ✅ `[x]` Chain Heights (live) tablica
- ✅ `[x]` “Participate” modal s QR
- ✅ `[x]` **Contributions panel**: jasni naslovi (“Totals by chain” / “Recent”), USD stupci, explorer linkovi
- ✅ `[x]` **Chain logotipi (SVG)** u Chain Heights + **avatar pozadina**
- ✅ `[x]` Prikaz nativnih iznosa s punom preciznošću
- ☐ `[ ]` Status bedževi po chainu (OK/STALE/ERR) iz API metadata
- ☐ `[ ]` Polirati empty/loading/error state-ove

---

## Phase 6 — Community Blocks (Top 15) — optional
- ☐ `[ ]` Treemap (“battle” view) using Recharts; fed by overview/rollups

---

## Phase 7 — Domain, Security, Perf
- ✅ `[x]` `blockbattle.org` live on Vercel
- ☐ `[ ]]` Optional Cloudflare proxy
- ☐ `[ ]` CORS allow-list → production origin only
- ☐ `[ ]` Token-bucket rate limit na public API
- ✅ `[x]` `/api/health`
- ☐ `[ ]` Centralized structured logging

---

## Phase 8 — Post-MVP
- 🟡 `[~]` **FX real-time na insert** (batch ostaje kao fallback)
- ☐ `[ ]` Token donations (ERC-20 `Transfer` logs na project wallets)

---

## Phase 9 — Exploratory Visualizations
- ☐ `[ ]` Tetris grid view
- ☐ `[ ]` Three.js 3D prototype

---

## Tech-Debt & Cleanup
- 🟡 `[~]` ENV cleanup
  - ✅ `[x]` Keep: `NOWNODES_API_KEY`, `CRON_SECRET`, `SUPABASE_*`, per-chain `*_RPC_URL`
  - ✅ `[x]` AVAX RPC mora imati `/ext/bc/C/rpc`
  - 🟡 `[~]` BTC preko Blockstream/Mempool → `BTC_API_BASE`
  - 🟡 `[~]` Ukloniti legacy grupe (`*_RPC_URLS`, stari DOGE/LTC tunables) kad više nisu u upotrebi
- 🟡 `[~]` Zadržati `/ingest/matic` alias privremeno; ukloniti kad svi scheduleri koriste `/ingest/pol`
- ☐ `[ ]` Uniform error payload kroz ingest rute
- ☐ `[ ]` Unit testovi za helpere; smoke testovi za API-je

---

## Immediate Next Steps
1. **FX real-time na insert** (zadržati batch kao fallback).  
2. **CORS + rate limit** na public rutama.  
3. **Status metadata** u `/api/public/overview` + UI bedževi (OK/STALE/ERR).  
4. Polirati loading/empty/error state-ove.

---

### ENV (production)
- `NOWNODES_API_KEY`, `CRON_SECRET`  
- `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`  
- Per-chain RPCs: `ETH_RPC_URL`, `OP_RPC_URL`, `ARB_RPC_URL`, `POL_RPC_URL`, `AVAX_RPC_URL`,  
  `DOT_RPC_URL`, `ATOM_RPC_URL`, `XRP_RPC_URL`, `SOL_RPC_URL`, `XLM_HORIZON_URL`, `TRX_RPC_URL`, `BSC_RPC_URL`  
- BTC: `BTC_API_BASE` (Blockstream/Mempool)

---

## Changelog (today)
- **FX batch sync** (CoinGecko) u produkciji; puni `amount_usd`.  
- Ispravljen **MATIC ⇢ POL** mapping (CoinGecko IDs).  
- **Public leaderboard**: `usd_total`, `?order=usd`, compat ruta.  
- **Recent contributions**: response dodaje `amount_usd`.  
- **UI Contributions panel**: naslovi kartica + USD stupci + explorer linkovi.  
- **Chain Heights**: dodani SVG logoi + avatar pozadina.  
- Env helper: service-role/anon fallback.

