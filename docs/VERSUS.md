# Live versus (P2P over WebRTC)

Status: implemented. Two players race the same chart live — synchronized
start, streaming opponent bar, win/lose standings — with **no game server**:
the match runs peer-to-peer on an RTCDataChannel, and the only server
involvement is a tiny HTTP signaling exchange on the existing Vercel
deployment.

## Architecture

```
host                       /api/versus (HTTP)                    joiner
────                       ──────────────────                    ──────
create offer SDP  ──POST create──▶  room row (code, chart, offer)
show arrow code                     │
                                    ◀──GET ?code── fetch chart+offer
                   ◀─poll answer──  ◀─POST answer─ send answer SDP
        └──────────── RTCDataChannel (P2P, server out of the loop) ──────────┘
   hello ⇄ ready ⇄ load ⇄ loaded ⇄ ping/pong ⇄ go ⇄ snaps ⇄ finish
```

- **Signaling** (`src/net/signalApi.ts`, `api/versus.ts`): plain
  request/response HTTP — works on serverless, no WebSocket, no Redis. Rooms
  are ephemeral rows (10-minute TTL, one answer each) in Postgres in
  production (`pgSignalStore.ts`) or memory in dev (Vite middleware). ICE is
  non-trickle: each side waits for candidate gathering and ships ONE complete
  SDP.
- **Match flow** (`src/net/versusMatch.ts`): a pure, transport-agnostic state
  machine, host-authoritative for coordination only. Judging never crosses
  the wire — each side judges its own input on its own audio clock and
  streams derived stats (percent/combo/life at ~5 Hz), the authoritative-local
  model from docs/ONLINE-MULTIPLAYER.md.
- **Synchronized start**: when both report loaded, the host probes RTT once
  (ping/pong), then sends `go(delayMs)` and starts itself at
  `delayMs + rtt/2` — both machines begin on the same wall instant. The e2e
  measures the two song clocks within ~10 ms on localhost. The engine seam is
  `GameSession.prepare()`/`begin()` (src/game/session.ts) — solo play's
  `start()` is the two back to back.
- **Room codes are 6 pad arrows** (`←↓↑→…`), so joining is fully pad-operable:
  the joiner literally presses the code on the pad. Codes live in
  `src/net/versus.ts`.

## Player flow

Song list → SELECT menu → VERSUS → CREATE ROOM (shows the arrow code) or JOIN
WITH CODE (press the 6 arrows). The joiner needs the same chart, matched by
content hash against the loaded library (open the pack first — lazy catalog
entries aren't scanned). Both press START in the lobby; the song starts on
both machines together. During play the top-left bar shows the rival's live
percent/combo and your lead/deficit; results show WIN/LOSE/DRAW once both
finish. Rate is locked to the host's music rate; RETRY is hidden (a rematch
is a fresh room). A mid-song disconnect marks the rival DISCONNECTED and the
local game plays out normally. Versus plays still submit to the async
leaderboard like any play.

## Limits & follow-ups

- **NAT**: STUN only (Google's public server). Peers who are both behind
  symmetric NAT/CGNAT can't hole-punch and get "COULD NOT CONNECT" — a TURN
  relay is the known fix if this bites real users. P2P also means the two
  players' IPs are visible to each other.
- **2 players.** More would mean a mesh or a relay; out of scope for now.
- Signaling on prod requires `DATABASE_URL` (the same Neon database as the
  leaderboards); without it /api/versus reports unavailable and the panel
  says so.
- Trust: friends racing friends. The finish results ride the channel
  unverified (the leaderboard's server-side checks still apply to ranked
  submissions).

## Tests

- Unit: `tests/versusMatch.test.ts` (full choreography over fake channels,
  half-RTT compensation, disconnects, hostile frames),
  `tests/signalApi.test.ts` (rooms, one-answer rule, expiry).
- E2E: `e2e/versus.e2e.mjs` — two real Chrome contexts host/join via the
  arrow-code pad path, WebRTC through the dev middleware, synced start
  (clock delta asserted < 350 ms, observed ~10 ms), live opponent bars both
  ways, mid-song disconnect handling.
