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
  5xx → the play parks in a localStorage queue (newest 50) and retries on app
  start and the next submit. 4xx (the server will never take it) → dropped.
- **API** (`api/scores.ts` → src/net/scoresApi.ts): Web-signature Vercel
  Function. `POST /api/scores` validates against src/net/protocol.ts (all
  client input is hostile), folds the play into the stored best with the same
  merge policy as local scores (mergeStoredBest), returns rank + PB flag.
  `GET /api/scores?chartHash=..&rate=1&limit=20` returns the board.
- **UI**: `GlobalBest` (src/ui/GlobalBest.tsx) in the song-select header shows
  the world best + your rank for the highlighted chart at the current rate.
  Informational only — takes no input, so pad-only operation is untouched.
  Renders nothing when offline or the board is empty.

## Deploying

1. In the Vercel project, add a Postgres database (Marketplace → Neon) and let
   it set `DATABASE_URL` on the project.
2. Deploy. The schema (`net_players`, `net_scores`) bootstraps itself on the
   first request (`CREATE TABLE IF NOT EXISTS`, src/net/pgScoreStore.ts).

Without `DATABASE_URL` the endpoint falls back to an in-memory store (scores
last as long as the function instance) — enough for previews, useless for real
boards. The client needs no configuration either way; it just talks to
`/api/scores` on its own origin and hides the UI when that fails.

## Trust model (M1)

The client is authoritative for its own score (see ONLINE-MULTIPLAYER.md §8.1
for why that is unavoidable). The API enforces shape and plausibility
(percent 0..1, integer counts with sane bounds, maxCombo ≤ judged steps), and
identity spoofing is blocked by the secret hash — but a modified client can
submit a fabricated score. Replay-proofs and statistical checks are M4
hardening; boards are best-effort honest until then.

## Ghosts (race the ghost)

- `GameSession` samples the scoreboard timeline at 2 Hz
  (`ghostFrames: GhostFrame[]` — atSong/percent/combo/life, capped at
  `MAX_GHOST_FRAMES`; never in practice mode). The submission carries it;
  the server keeps a ghost only on the row it belongs to (the personal best —
  a better ghostless play clears the stale one).
- `GET /api/scores?...&ghostOf=playerId` serves a stored ghost;
  `LeaderboardRow.hasGhost` marks racable rows.
- In Play, the best racable timeline on the board (which may be your own PB —
  labeled YOUR BEST) drives the `GhostRace` badge: your live percent vs the
  ghost's at the same song position, green ahead / red behind. Read-only
  overlay; hidden offline, in practice mode, or when no ghost exists yet.

## Player name

Options → ONLINE → PLAYER NAME (src/ui/Options.tsx), backed by
`setPlayerName`. Renames propagate to all your rows on the next accepted
submission.

## RANKS side panel

The board for the highlighted chart renders beside the song list
(src/ui/LeaderboardSide.tsx): top rows with rank, name (yours highlighted),
percent, grade, and a ▶ marker on racable (ghost) rows. Purely informational
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

- Anti-cheat beyond plausibility checks (M4: replay proofs, anomaly detection).
