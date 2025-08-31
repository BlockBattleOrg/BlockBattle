// app/api/public/contributions/leaderboard/route.ts
// Back-compat shim for UI: delegate to the new leaderboard implementation.

export { GET, runtime, dynamic } from "../../leaderboard/route";

