# BlockBattle.org

**BlockBattle.org** is a transparent, year-long crypto community challenge designed to measure and showcase the collective support of different cryptocurrency ecosystems.  
Participants voluntarily contribute to public blockchain addresses, and their contributions are ranked in real-time, creating a friendly competition among the **Top 15 most popular cryptocurrencies**.

## 🌟 Key Features (MVP)
- **Hero section** — clear call-to-action for participation.
- **Live Top 15 ranking** — logo, name, total contributed (USD equivalent), transaction count, and participate button.
- **Community Blocks visualization** — treemap showing block sizes proportional to total contributions per currency.
- **Countdown timer** — remaining time until the challenge ends.
- **Transparency** — all blockchain addresses, code, and data are public.
- **Optional community messages** — scrolling ticker for short messages.

## 🛠 Tech Stack
- **Frontend:** Next.js + TailwindCSS + Recharts
- **Database:** Supabase (PostgreSQL with RLS)
- **Backend API:** Supabase Functions or Vercel Serverless Functions
- **Deployment:** Vercel (GitHub integration)
- **Blockchain Data:** GetBlock (primary), optional CoinGecko for USD conversion
- **Wallets:** Exodus wallet — one address per currency

## 📅 Project Plan
The development follows a phased approach, ensuring every stage is tested, committed, and deployed before moving to the next.  
Full plan and checklist are available in [`PLAN.md`](PLAN.md).

## 🔒 Privacy & Security
- All commits use GitHub `noreply` email for anonymity.
- API keys and sensitive data are never stored in the repository — environment variables are used instead.
- Public transparency is a core value — all participation addresses and aggregation logic are open.

## 📜 License
MIT License — see the [LICENSE](LICENSE) file for details.

---

**Website:** [https://blockbattle.org](https://blockbattle.org)  
**Repository:** [https://github.com/BlockBattleOrg/BlockBattle](https://github.com/BlockBattleOrg/BlockBattle)
