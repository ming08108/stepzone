# Multiplayer rooms (P2P over WebRTC)

Status: implemented. A ROOM is a persistent party of up to 8 players that
lasts across songs: friends join once and keep racing until they leave — with
**no game server**. Every match runs peer-to-peer on RTCDataChannels in a STAR
around the host, and the only server involvement is a tiny HTTP signaling
exchange on the existing Vercel deployment.

## Architecture

```
host                        /api/versus (HTTP)                     joiners (N)
────                        ──────────────────                     ───────────
create room  ──POST create──▶  room row (code, heartbeat)
show arrow code                     │
poll ?role=host ◀──────────────  join rows   ◀──POST join── joiner offer SDP
POST answer     ──────────────▶  (offer/answer  ◀─poll answer── each joiner
                                  per joiner)
      └────────── RTCDataChannel per joiner (P2P star, host = hub) ──────────┘
  hello ⇄ welcome/roster ⇄ song ⇄ ready ⇄ load/loaded ⇄ ping/pong ⇄ go ⇄
  snaps/notes (relayed) ⇄ finish ⇄ roster(lobby) … next song, same room
```

- **Signaling** (`src/net/signalApi.ts`, `api/versus.js`): plain
  request/response HTTP — works on serverless, no WebSocket. V2 is
  *joiner-initiated*: the room row is just "this code has a live host"
  (Postgres in prod via `pgSignalStore.ts`, memory in dev); each joiner posts
  an offer row and the host, polling, answers it. The host's poll doubles as
  a heartbeat — a room is joinable while its host keeps polling (parties can
  last hours; abandoned rooms vanish in a minute). ICE is non-trickle: each
  side ships ONE complete SDP.
- **Room controllers** (`src/net/roomPeer.ts`): `RoomHost`/`RoomGuest`, pure
  transport-agnostic state machines sharing one observable surface. The host
  is authoritative for coordination only: roster, song, phase, start. Judging
  never crosses the wire — each player judges their own input on their own
  audio clock and streams derived stats (snap percent/combo/life at ~5 Hz)
  plus judged-note display events; the host relays them hub-and-spoke
  (`psnap`/`pnotes`/`pfinish` tagged with player ids).
- **Synchronized start**: when every racer reports loaded, the host probes
  each guest's RTT once (ping/pong) and issues per-guest `go(delayMs)` frames
  compensated by half their RTT — every machine begins on one wall instant
  (the e2e asserts the clocks within ~10 ms on localhost). The engine seam is
  `GameSession.prepare()`/`begin()` (src/game/session.ts).
- **Room codes are 6 pad arrows** (`←↓↑→…`), so joining is fully pad-operable.
  A `?join=CODE` link auto-joins at load. Codes live in `src/net/versus.ts`.

## Player flow

**The room is global state** (`src/ui/roomStore.ts`) — it survives every
screen change. Host from the MULTIPLAYER panel on song select (SELECT on the
pack grid) or the MULTIPLAYER row on PLAYER OPTIONS; join from the same panel
by pressing the 6 arrows, or via the invite link. No song is needed to host
or join.

**The cycle**: the host browses and picks a song like any solo play; landing
on PLAYER OPTIONS announces it to the room (title + every chart hash — songs
are identified by chart CONTENT hash, never by name, so same-name charts
can't collide). Guests auto-follow: their copy resolves by ANY hash match,
and **a guest who lacks the song gets it from the host, peer to peer** — the
original simfile text, the audio bytes, and the background art (when it fits
the 32 MB cap) stream over the already-open channel (`fileMeta` + chunked
binary with backpressure, `net/versusTransfer.ts`) and land in their library
through the normal drop path. Everyone lands on their own PLAYER OPTIONS,
**picks their own difficulty** (arcade style; picks relay live on the roster
dock), and STARTs to ready up. When ALL present players are ready the song
starts everywhere together. Music rate is room-locked per song (the host's
rate at announce time). Practice is unavailable in a room.

During play the rivals' live percent/combo bars stack top-left (ahead/behind
colored); a 1v1 race also renders **the rival's playfield beside yours in the
same GpuNoteField render** (mirror judge fed by their note stream, one canvas,
one shared background — src/render/gpu). Results land in **ranked standings
with a last-place-first reveal animation — any START press skips it**.
Quitting mid-song is a DNF, not a room end. CONTINUE returns everyone to the
same room: the host picks the next song, guests' docks read "THE HOST IS
PICKING A SONG…". A guest leaving just shrinks the roster; **the host leaving
closes the room** (star topology — there is nothing to relay through). Room
plays still submit to the async leaderboard like any play.

## Limits & follow-ups

- **NAT**: STUN only (Google's public server). Peers who are both behind
  symmetric NAT/CGNAT can't hole-punch and get "COULD NOT CONNECT" — a TURN
  relay is the known fix if this bites real users. P2P also means players'
  IPs are visible to each other.
- **8 players max** (`MAX_PLAYERS`) — the host relays everything, so fan-out
  is host upload bandwidth.
- The host is the hub: no host migration. Host leaves → room over.
- Different chart revisions of the same song: a rival's exact pick may not
  exist locally (opponent chart is null) — bars/standings still work.
- Song transfer caps: simfile ≤ 2 MB of text, audio ≤ 64 MB, background ≤
  32 MB (oversized backgrounds are omitted, never fatal); hosts without
  original files (synth starter entries) reply CANNOT SHARE. Transferred
  songs live for the session only. Sharing is between players directly — the
  host should own what they share.
- Signaling on prod requires `DATABASE_URL` (the same Neon database as the
  leaderboards); without it /api/versus reports unavailable.
- Trust: friends racing friends. Results ride the channel unverified (the
  leaderboard's server-side checks still apply to ranked submissions).

## Tests

- Unit: `tests/roomPeer.test.ts` (full N-player choreography over fake
  channels: admission caps, protocol-version rejection, per-guest half-RTT
  compensation, hub relays, stale-cycle guards, DNFs, lobby return),
  `tests/signalApi.test.ts` (rooms, heartbeat liveness, join expiry,
  double-answer), `tests/versusTransfer.test.ts` (multi-file sink).
- E2E: `e2e/versus.e2e.mjs` — three real Chrome contexts: host + arrow-code
  joiner + ?join= link joiner, WebRTC through the dev middleware, synced
  start (clock delta asserted < 350 ms, observed ~10 ms), live rival bars
  both ways, one-canvas dual field, mid-song quit-as-DNF with the room
  surviving, a second song on the SAME room transferred P2P to two guests,
  and the skippable standings reveal.
