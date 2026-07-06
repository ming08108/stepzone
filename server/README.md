# Shared leaderboards

Scores are keyed by **chart content hash** (`src/song/chartHash.ts`): a
truncated SHA-256 over the steps type, every note, and the tempo map. Two
players' independently-downloaded copies of a song land on the same board;
retitled/resynced/renamed simfiles don't split it; any real step or BPM edit
does. Each difficulty is its own board.

The game submits a completed (non-practice) play automatically and shows the
board on the results screen. Configure under **OPTIONS → LEADERBOARD**:
`PLAYER NAME` plus a `SERVER URL` (leave empty to turn the feature off).
Everything network-side fails silent — an unreachable server never blocks or
errors the game.

Two interchangeable backends serve the same two-endpoint API
(`POST /api/scores`, `GET /api/scores/:hash?player=NAME`):

## Vercel (serverless) — deploy the game and the board together

Serverless functions have no process lifetime or shared filesystem, so state
lives in Upstash Redis; the functions in `api/` talk to its REST endpoint with
plain `fetch` (no dependencies). A chart's board is a sorted set — `ZADD GT`
is an atomic "keep the best" merge, immune to concurrent submissions.

1. Vercel dashboard → your project → **Storage** → add **Upstash Redis**
   (Marketplace). This injects `KV_REST_API_URL` / `KV_REST_API_TOKEN`
   (older `UPSTASH_REDIS_REST_*` names also work).
2. Deploy. The `api/` folder becomes the functions automatically.
3. In the game: **OPTIONS → LEADERBOARD → SERVER URL** = `/`
   (same-origin; a full `https://your-app.vercel.app` also works from
   elsewhere, e.g. a locally-run copy of the game).

Without the storage attached the functions answer 503 and the game simply
shows no boards.

## Standalone (LAN / self-hosted) — no accounts needed

`server/leaderboard.mjs` is a single-file, zero-dependency Node server with
JSON-file persistence:

```
npm run leaderboard          # http://localhost:8791
PORT=9000 npm run leaderboard
```

Point `SERVER URL` at `http://<host>:8791`. State persists to
`server/leaderboard-data.json` (gitignored).

Both backends share the same validation (`server/validate.mjs`) and are held
to the same contract by tests (`tests/leaderboardServer.test.ts`,
`tests/leaderboardApi.test.ts`).

**Trust model:** names are self-declared and submissions are unauthenticated —
built for friends and communities, not for adversarial public ranking.
