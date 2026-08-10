# Online leaderboards (M1)

Status: implemented (client + API). This is mode 1 of docs/ONLINE-MULTIPLAYER.md
— async leaderboards, no live connection during play. Everything runs on the
existing Vercel deployment; no second service.

## How it works

- **Board key**: `chartContentHash(song, chart)` (src/song/chartHash.ts) — the
  same content identity local scores use — partitioned by music rate
  (`rateKey`: 1.0x and 1.5x are different boards).
- **Identity**: anonymous claim-on-first-submit (src/net/identity.ts). The
  client invents a `playerId` + `secret` once (localStorage); the first
  submission binds them server-side (secret stored hashed), later submissions
  must match. No accounts. Display name defaults to `PLAYER` — rename via
  `setPlayerName` (UI affordance still to come).
- **Submission** (src/net/leaderboard.ts): `Play.tsx onEnd` fires a
  fire-and-forget submit for every non-practice play. Offline / undeployed /
  5xx / 429 → the play parks in a localStorage queue (newest 50) and retries on
  app start and the next submit. Other 4xx responses are dropped. Queue
  updates are serialized across tabs when Web Locks is available.
- **API** (`api/scores.ts` → src/net/scoresApi.ts): Web-signature Vercel
  Function. `POST /api/scores` validates against src/net/protocol.ts (all
  client input is hostile), atomically folds the play into the stored best,
  returns rank + PB flag, and rate-limits submissions by credential and trusted
  proxy address.
  `GET /api/scores?chartHash=..&rate=1&limit=20` returns the board.
- **UI**: `GlobalBest` (src/ui/GlobalBest.tsx) in the song-select header shows
  the world best + your rank for the highlighted chart at the current rate.
  Informational only — takes no input, so pad-only operation is untouched.
  Renders nothing when offline or the board is empty.

## Deploying

1. In the Vercel project, add a Postgres database (Marketplace → Neon) and let
   it set `DATABASE_URL` on the project.
2. Deploy. The schema (`net_players`, `net_scores`, `net_score_rate_limits`) bootstraps itself on the
   first request (`CREATE TABLE IF NOT EXISTS`, src/net/pgScoreStore.ts).

Without `DATABASE_URL` the endpoint falls back to an in-memory store (scores
last as long as the function instance) — enough for previews, useless for real
boards. The client needs no configuration either way; it just talks to
`/api/scores` on its own origin and hides the UI when that fails.

## Trust model (M1)

**Server-side replay verification (v4) — the score is NOT trusted.** A
submission ships the full input replay (song-seconds press/release log) AND the
chart it ran on (`chartData`: raw note grid + resolved timing). On every POST
the server (src/gameplay/replayVerify.ts, bundled into the scores function):

1. Recomputes the chart's content hash from the shipped parts and rejects the
   submission unless it equals the board's `chartHash` — so the payload is the
   exact chart the board is keyed on, never an easier substitute.
2. Re-runs the real `Judge` over the replay (the same `step()`/`update()` the
   live play used) and **derives the score from what the inputs actually
   produce**. The client's self-reported `result` is ignored for ranking — a
   forged 99% with a replay that scores 40% is stored as 40%.

Pad-only submission is a client-side product rule; browsers cannot attest that
a replay came from a physical pad, so the API makes no such claim. Identity
spoofing is blocked by the secret hash. What survives: a **bot/TAS**
that genuinely produces winning inputs for the chart — the irreducible limit
for any rhythm game, and the target for statistical anomaly detection later.
Compute is bounded against a crafted chart (note-grid + timing-segment caps in
protocol.ts, a fine-sim horizon cap in replayVerify.ts).

## Player name

Options → ONLINE → PLAYER NAME (src/ui/Options.tsx), backed by
`setPlayerName`. Renames propagate to all your rows on the next accepted
submission.

## RANKS side panel

The board for the highlighted chart renders beside the song list
(src/ui/LeaderboardSide.tsx): top rows with rank, name (yours highlighted),
percent and grade. Purely informational
(no focus, no input — pad-only untouched); collapses when offline and hides
on narrow viewports. It shares one debounced/cached fetch with the header's
WORLD readout (src/ui/useLeaderboard.ts).

## Dev & tests

- `npm run dev` serves /api/scores itself via a Vite middleware
  (src/net/devApiPlugin.ts) — the production handlers on an in-memory store —
  so the whole feature works locally and in e2e with no Vercel/Neon setup.
- Unit: tests/netProtocol.test.ts, tests/scoresApi.test.ts,
  tests/leaderboardQueue.test.ts. E2E: e2e/leaderboard.e2e.mjs (real Chrome:
  seeds the board through POST, asserts the WORLD line and the RANKS panel on
  the pad key proxy).

## Not yet built

- Anti-cheat beyond replay re-simulation (statistical anomaly detection to
  catch bots/TAS that produce genuinely-winning inputs).
