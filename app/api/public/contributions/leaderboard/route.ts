// app/api/public/contributions/leaderboard/route.ts
// Back-compat shim: reuse the new leaderboard handler, but export runtime/dynamic as literals
export { GET } from "../../leaderboard/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

