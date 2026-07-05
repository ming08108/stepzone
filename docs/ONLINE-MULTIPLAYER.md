# Online Multiplayer — design & investigation

Status: investigation / design. No code yet. This document proposes how to add
online multiplayer to Stepzone, informed by how StepMania/ITGmania did (and now
does) it, and by Stepzone's own clock/judgment architecture.

The one-line thesis, up front:

> **Every client judges its own input on its own audio clock and broadcasts only
> derived stats (judgment counts, combo, life, score). A small WebSocket relay
> server carries the lobby, the shared "go" timestamp, the live stat stream, and
> chat. Raw input timing never crosses the wire.**

This is the same "authoritative-local" model StepMania used, and it is the _only_
model that survives the web's two-timebase clock problem (§2).

---

## 1. How StepMania / ITGmania do online play

### 1.1 What is actually in this ITGmania tree

Grepping `itgmania/src`, the **classic peer-to-server netplay is gone**. The old
StepMania 5 files — `NetworkSyncManager.cpp`, `ezsockets.cpp`,
`ScreenNetSelectMusic.cpp`, `ScreenNetRoom.cpp`, `ScreenNetEvaluation.cpp` —
are referenced only in `Docs/Changelog_sm5.txt` (e.g.
`[ScreenNetSelectMusic] Add PlayerOptionsScreen metric`,
`[ScreenNetSelectBase] Fix colors ... in chat box`); the sources were removed
from this fork.

What remains is `src/NetworkManager.{h,cpp}` (© 2021 natano) — a **generic HTTP
client + WebSocket client** built on `ixwebsocket`, exposed to Lua
(`HttpRequest`, `WebSocket`, `IsUrlAllowed`, an allow-host preference). It is not
a game-sync system; it is plumbing that themes call. In practice ITGmania's
"online" is **GrooveStats**: the Simply Love theme uses `NetworkManager`'s HTTP
API to submit scores and pull **async leaderboards** over HTTPS. That is
leaderboard/score-submission only — no live shared session, no rooms, no chat in
the engine.

So there are effectively **two references** to learn from:

- **Historical StepMania SMOnline/SMLAN** — the live, room-based, TCP netplay
  (below). This is the real "multiplayer" prior art.
- **ITGmania + GrooveStats** — modern async leaderboards over HTTP, done entirely
  in theme Lua on top of a generic HTTP/WS client.

### 1.2 The classic SMOnline / SMLAN protocol (the prior art to copy)

Transport and shape:

- **TCP**, one long-lived connection from each client to a **central server**
  (via the `ezsockets` wrapper). **Client/server, not peer-to-peer.** LAN
  (`SMLAN`) and internet (`SMOnline`) used the same protocol against a local vs.
  hosted server.
- Custom **binary packets**: a one-byte command tag (the `NSCommand` enum)
  followed by a payload of big-endian ints and length/NUL-delimited strings,
  assembled/parsed by a `PacketFunctions` reader/writer.

The command set (names abbreviated `NSC*` = "Network StepMania Command"):

| Tag                                    | Direction    | Purpose                                                                                                                                                                             |
| -------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NSCPing` / `NSCPingR`                 | both         | keepalive + **round-trip latency** measurement                                                                                                                                      |
| `NSCHello`                             | C→S, reply   | handshake: protocol version + client name; server replies with its name + feature flags (and whether login is required)                                                             |
| `NSCGSR` (Game Start Request)          | C→S          | player is entering gameplay: song **title/artist/subtitle + hashes**, chart type/difficulty/meter, player count/side/names. Server **gates** the start                              |
| `NSCGSU` (Game Status Update)          | C→S, fan-out | **live in-song stat stream**: per player, current judgment tallies, combo, life/health, score, last offset. Sent periodically (per note / per interval). Drives the live scoreboard |
| `NSCGON` (Game Over Notice)            | C→S, reply   | end of song; server returns aggregate placing/summary                                                                                                                               |
| `NSCSU` (Style Update)                 | both         | player join / side / seat info                                                                                                                                                      |
| `NSCCM` (Chat Message)                 | both         | lobby/room chat text                                                                                                                                                                |
| `NSCRSG` (Request Start Game / select) | both         | room song coordination: which song a client has/selected so the server can converge everyone on one chart                                                                           |
| `NSCUUL` (Update UserList)             | S→C          | roster: users in room/lobby + per-user status                                                                                                                                       |
| `NSCSMS` (Select Music Screen)         | C→S          | client announces it entered the net song-select (group/title)                                                                                                                       |
| `NSCUOpts` (User Options)              | both         | a player's mods/options string                                                                                                                                                      |
| `NSCSMOnline`                          | both         | wraps the SMOnline room-management **sub-protocol** (login, list/create/enter room, room info)                                                                                      |
| `NSCFormatted` / `NSCAttack`           | S→C / both   | server info strings / **battle-mode** modifier "attacks" sent at another player                                                                                                     |

The screen flow: `ScreenNetworkOptions` (connect) → `ScreenNetRoom` (room list +
lobby chat) → enter a room → `ScreenNetSelectMusic` (in-room song wheel; exchange
who _has_ the chart, mark ready) → server says start → **each client plays its
own local copy**, streaming `NSCGSU` → `NSCGON` → `ScreenNetEvaluation` (combined
results).

### 1.3 What the classic protocol got right — and its limits

Right (and worth copying):

- **Authoritative-local judging.** Each client judges its own input against its
  own audio; the server only **relays and aggregates**. No attempt to judge a
  remote player's taps on the host's clock. This is exactly what the web forces
  on us too (§2), so it is the correct base model.
- **Small payloads.** Only _derived_ stats stream during play (counts, combo,
  life, score) — never raw per-input timing.
- **Latency-tolerant.** `NSCPing` measures RTT; the scoreboard tolerates jitter
  because it is a status feed, not a lock-step simulation.
- **Dial-out topology.** Clients connect _out_ to the server, so no inbound NAT
  hole-punching is needed on the player side.

Limits (things we must fix or accept):

- **No shared sample-accurate clock.** Songs start "around" the same moment and
  each client's audio free-runs; there is no cross-machine audio phase lock and
  no correction for drift. It is a **live-scoreboard race**, not frame-locked
  co-op. That is fine — _because judging is local, it does not need to be._
- **Trivially cheatable.** The client is fully authoritative over its own score;
  the server trusts `NSCGSU`/`NSCGON`. Nothing stops a client from sending a
  perfect score. Anti-cheat was essentially absent.
- **Exact-chart requirement.** You must own the identical chart (matched by
  hash) to play it together.
- **Not web-reachable.** Raw TCP + custom binary is unusable from a browser
  (JS has no raw TCP sockets) and needs a native dedicated server.

Takeaway for Stepzone: **keep the authoritative-local model and the small stat
feed; replace TCP+binary with WebSocket+JSON; add the anti-cheat and shared-start
pieces SM never had.**

---

## 2. Stepzone's architecture, and why remote judging is impossible

Stepzone already judges exactly the way a netplay client must. The relevant
pieces:

**Two-timebase clock** (`src/audio/syncMap.ts`, `src/audio/clock.ts`,
`docs/LATENCY.md`). Audio runs on `AudioContext.currentTime` (seconds); input
timestamps (`KeyboardEvent.timeStamp`) run on `performance.now()` (ms). They are
different clocks. `WebAudioClock` samples `getOutputTimestamp()` to get an anchor
`{contextTime, performanceTime}` — "the sample at contextTime is _heard_ at
performanceTime" — and `SyncMap` interpolates from it. Judgment reads
`songSecondsAtEvent(e.timeStamp)`; rendering reads `songSecondsNow()`. Both go
through the **same anchor**, so input and audio share one _audible_ axis.

**Per-client, un-shareable state**, each of which shifts the mapping between an
input event and a song position:

- `SyncMap.audioOffsetSeconds` — the user's device calibration (Bluetooth audio
  alone is 100–300 ms and varies by device, per `docs/LATENCY.md`).
- The device's real `outputLatency` (only partially observable).
- `SyncMap.startContextTime` — when _this_ machine's song-second 0 begins.
- `SessionConfig.musicRate` and `visualOffsetMs`.

**Local judgment engine** (`src/gameplay/judge.ts`, `src/gameplay/scoring.ts`).
Pure. `Judge.step(track, timeSeconds, release)` classifies an input against the
nearest note; `Judge.update(now, held)` ages misses and holds. It exposes exactly
the state a netplay scoreboard needs:

- `combo`, `maxCombo`, `missCombo`
- `life` (0..1), `failed`
- `percentDancePoints` (0..1), `grade` (string, e.g. `AAA`/`AA`/`A`)
- `tapCounts` / `holdCounts` — `Record<TapNoteScore|HoldNoteScore, number>`
  (`TapNoteScore` enum: `W1=9 … W5=5, Miss=4, HitMine=1`, etc.)
- a monotonically increasing `judgmentSeq` + `lastTns` (already a natural
  "something changed, emit an update" trigger).

**Session lifecycle** (`src/game/session.ts`, `src/ui/Play.tsx`).
`GameSession.start(encodedAudio)` resumes the context and calls
`clock.start(0, LEAD_IN_SECONDS=2)` — a fixed **2-second lead-in** (song time is
negative during it), which is a convenient shared countdown handle for netplay.
`session.onEnd = (judge) => …` fires at the end; `Play.tsx` reads `judge` and
calls `recordPlay(chartKey(song, chart), {percent, grade, maxCombo, counts})`
into localStorage (`src/app/scores.ts`). `chartKey` is
`` `${songKey}·${stepsType}·${difficulty}·${meter}` `` — a ready-made
leaderboard key.

### Why you cannot judge a remote player locally

A remote player's `event.timeStamp` is meaningless on my machine: it is on
**their** `performance.now()` epoch, reflects **their** `audioOffsetSeconds` and
**their** output latency, and is anchored to **their** `startContextTime`. To
re-judge it here I would have to reconstruct their entire `SyncMap` and audio
pipeline — and network jitter would still make the arrival time useless for a
±22 ms window. So:

> Each client judges its **own** input with its **own** `Judge`/`SyncMap`, and
> emits only the _outputs_ of judgment. This is not a limitation to work around;
> it is the design. It also happens to be un-cheatable-timing-wise: nobody else's
> clock can grade you.

The shared quantities are therefore **small and clock-independent**: judgment
counts, combo, life, running %, grade, and final results.

---

## 3. What "online multiplayer" should mean here

Three realistic modes, in increasing order of coordination difficulty:

1. **Async ghost / leaderboard races.** No live connection needed at play time.
   Submit a finished play (score + judgment counts + optional per-note "replay"
   ghost) keyed by `chartKey`; browse leaderboards; race a stored **ghost** whose
   combo/life bar animates beside yours from its recorded timeline. This is the
   GrooveStats model and the cheapest, most robust win. It also works offline
   (queue and submit later).

2. **Real-time synchronized versus.** Two-plus players, **same chart**, start
   together on a server "go", each judging locally and streaming
   `scoreUpdate`s so everyone sees live **score %, combo, and life bars** for the
   whole field. Winner by final % (or survival, or first-to-fail-loses). This is
   the SMOnline live scoreboard, modernized.

3. **Spectate.** A degenerate case of (2): a viewer receives the `scoreUpdate`
   stream and renders remote bars without playing. Cheap once (2) exists.

4. **Rooms / lobbies with chat.** The social shell around (1)–(3): named rooms,
   a roster with ready state, chat, and a shared song pick. This is
   `ScreenNetRoom` + `ScreenNetSelectMusic` reimagined as web UI.

Non-goals (call them out explicitly): frame-locked **co-op on one shared field**
(pointless — see §2, and there is no shared clock), and any mode that requires
**judging remote input**.

---

## 4. Recommended web architecture

### 4.1 Transport: a WebSocket relay server (Node)

A small **Node WebSocket server** (`ws` or `uWebSockets.js`) is the right spine:

- Browsers can open a `WebSocket` natively (unlike raw TCP), so no plugin/native
  client. TLS (`wss://`) is a checkbox.
- It carries **all four modes**: lobby/roster/chat, the shared-start handshake,
  the live stat stream, and (for async) it can also expose the leaderboard HTTP
  endpoints. One process, one origin.
- It is a **relay + referee**, not a simulation: it fans out messages, stamps the
  authoritative "go" time, and runs cheap sanity checks (§6). It holds no game
  clock of its own beyond issuing timestamps.
- Topology matches SMOnline: every client dials **out** to the server, so player
  NAT never matters (§6.3).

Message encoding: **JSON** to start (debuggable, matches Stepzone's TS types
1:1). If the `scoreUpdate` feed ever gets heavy, switch that one message to a
binary/`MessagePack` frame — but at the volumes below (§5.3) JSON is fine.

Server responsibilities:

- Lobby: rooms, roster, ready state, chat fan-out.
- Session: collect readiness, compute a **start timestamp**, broadcast `start`.
- Relay: fan out `scoreUpdate` / `finish` to the room (and spectators).
- Referee: monotonicity/plausibility checks, timeouts, disconnect handling.
- Persistence (async mode): store finished results and serve leaderboards.

### 4.2 Authoritative-local clients (the SM model, kept)

Each client owns its `Judge` and `SyncMap`, judges its own input, and emits
`scoreUpdate` deltas + a `finish` summary. The server **relays and audits** but
never re-judges. This is drop-in with today's code: a `NetSession` wrapper would
subscribe to the existing `Judge` (its `judgmentSeq` bump is already the "emit"
signal) and forward a throttled snapshot.

### 4.3 WebRTC data channels — the lower-latency alternative

For the live-versus stream, **WebRTC `RTCDataChannel`** (unreliable/unordered
mode, i.e. UDP-like SCTP) can shave the relay hop and the head-of-line blocking
that TCP-based WebSocket imposes on a lossy link.

Tradeoffs — why it is a **later optimization, not the base**:

- **Still needs a server.** WebRTC requires a **signaling** channel (reuse the
  WebSocket) plus **STUN**, and a **TURN** relay for the ~10–20% of peer pairs
  that cannot hole-punch (symmetric NAT). TURN is bandwidth you pay for, so you
  do not actually escape hosting.
- **Anti-cheat regresses** in full mesh P2P: with no server in the data path,
  the referee (§6) cannot see the stat stream. You would keep the server in-path
  anyway for ranked, which erases most of the latency win.
- **Complexity.** ICE, session negotiation, per-peer channels, mesh scaling
  (N² channels). A WS relay is one connection per client.
- **The latency does not matter much here.** The stat feed is a _scoreboard_,
  not lock-step input; 50–150 ms of extra delay on a life-bar update is
  imperceptible. WebRTC pays off for real-time input exchange — which we
  explicitly do not do (§2).

Recommendation: **WebSocket relay for everything; consider a WebRTC data channel
only for the M3 versus stat feed in unranked/friendly rooms, with the WS server
still receiving a copy for auditing.**

---

## 5. Synchronization model

### 5.1 Clock offset estimation (NTP-style)

Reuse SMOnline's ping idea. Each client periodically exchanges `ping`/`pong` with
the server to estimate its **clock offset** and **RTT**:

```
offset ≈ ((t1 - t0) + (t2 - t3)) / 2      // t0 send, t1 server recv, t2 server send, t3 recv
rtt    ≈ (t3 - t0) - (t2 - t1)
serverNow(perfMs) ≈ perfMs + offset       // this client's estimate of server time
```

Keep a smoothed `offset` (median of the last N, discard high-RTT samples). This
lets every client translate a **server timestamp** into its **own**
`performance.now()` axis.

### 5.2 Shared start on a server "go"

The server does not say "start now"; it says **"start when server-time = `T0`"**,
choosing `T0 = serverNow + max(readyRTTs) + margin` (e.g. +1.5 s) so the slowest
client still has time. Each client converts `T0` to its local perf clock via §5.1
and schedules audio so **song-second 0 lands on `T0`**:

- Stepzone already schedules `source.start(when)` with a lead
  (`clock.start(offset, leadSeconds)` sets
  `startContextTime = when − offset/rate`). The net path computes the `when`
  (AudioContext time) whose _audible_ instant equals local-perf(`T0`), using the
  same `getOutputTimestamp` anchor that judging uses. The existing 2 s
  `LEAD_IN_SECONDS` doubles as the visible countdown.

What this buys and what it does **not**: the _conductor's baton drops together_
(scoreboards advance in lockstep within tens of ms), but **audio phase is not
identical across machines** — each device's output latency and the player's
`audioOffsetSeconds` differ. That is fine: nobody hears two machines at once, and
**judging is local**, so the only thing that must align is the _scoreboard
timeline_, which `T0` gives us.

### 5.3 Only aggregate stats cross the wire

Per §2, raw input timing is never sent. During play a client emits a `scoreUpdate`
snapshot:

- on a **coalesced timer** (e.g. every 100–250 ms), and/or
- on meaningful change (`judge.judgmentSeq` bumped, a life-bar threshold, a combo
  milestone).

Payload is tiny (counts + a few numbers, §7), so even at 10 Hz × 8 players the
relay load is trivial — JSON is fine. The server may **downsample** fan-out to
spectators.

### 5.4 Different rates / mods

Score comparability requires equal conditions. Rules:

- **Ranked / versus:** the room **locks** `musicRate`, mine/hold settings, and
  disallows score-affecting mods (turn mods like mirror are cosmetic-ish but
  should still be pinned for fairness); everyone must resolve the **same
  `chartKey`** (same `stepsType/difficulty/meter`) — matched by a chart **hash**
  so a re-authored file cannot masquerade. Clients that cannot produce the hash
  are blocked from readying.
- **Unranked / friendly:** allow rate/mods; display them per player and **do not**
  cross-rank the scores (show raw %, flag "modified").
- Async leaderboards are **partitioned by rate** (a 1.5× clear is a different
  board), exactly as GrooveStats does.

---

## 6. Data shapes (TypeScript sketches)

These mirror Stepzone's existing types (`TapNoteScore` counts, `life` 0..1,
`percentDancePoints`, `chartKey`). Envelope is a discriminated union on `t`.

```ts
// ---- identity & primitives ---------------------------------------------------
type UserId = string; // server-assigned, stable per connection
type RoomId = string;
type MatchId = string; // one song play within a room
type PerfMs = number; // performance.now()-style ms
type ServerMs = number; // server clock ms (see §5.1)

/** Judgment tallies, keyed by TapNoteScore/HoldNoteScore numeric enum value. */
type JudgmentCounts = Record<number, number>;

/** Immutable identity of a chart both sides must agree on (ranked). */
interface ChartRef {
  chartKey: string; // songKey·stepsType·difficulty·meter (src/app/scores.ts)
  chartHash: string; // hash of decoded NoteData — the anti-spoof key
  title: string;
  artist: string;
  stepsType: string;
  meter: number;
}

/** Conditions that must match for a ranked comparison. */
interface PlayConditions {
  musicRate: number; // 1 = normal
  ranked: boolean;
  mods: string[]; // turn/etc. — empty for ranked
}

// ---- client -> server --------------------------------------------------------
type ClientMsg =
  | { t: 'hello'; name: string; clientVersion: string }
  | { t: 'ping'; t0: PerfMs }
  | { t: 'joinRoom'; roomId: RoomId }
  | { t: 'createRoom'; name: string; conditions: PlayConditions }
  | { t: 'leaveRoom' }
  | { t: 'chat'; text: string }
  | { t: 'selectChart'; chart: ChartRef } // I propose / I have this chart
  | { t: 'ready'; ready: boolean; haveChart: boolean }
  | { t: 'loaded' } // audio decoded, ready for T0
  | { t: 'scoreUpdate'; match: MatchId; snap: ScoreSnapshot }
  | { t: 'finish'; match: MatchId; result: PlayResult };

// ---- server -> client --------------------------------------------------------
type ServerMsg =
  | { t: 'welcome'; you: UserId; serverName: string; serverTime: ServerMs }
  | { t: 'pong'; t0: PerfMs; t1: ServerMs; t2: ServerMs } // §5.1
  | { t: 'roomState'; room: RoomState }
  | { t: 'roster'; users: UserSummary[] } // cf. NSCUUL
  | { t: 'chat'; from: UserId; name: string; text: string } // cf. NSCCM
  | { t: 'chartLocked'; chart: ChartRef; conditions: PlayConditions }
  | { t: 'start'; match: MatchId; startAt: ServerMs; chart: ChartRef; conditions: PlayConditions }
  | { t: 'scoreUpdate'; match: MatchId; from: UserId; snap: ScoreSnapshot } // relayed
  | { t: 'playerFinished'; match: MatchId; from: UserId; result: PlayResult }
  | { t: 'matchOver'; match: MatchId; standings: Standing[] } // cf. NSCGON/Evaluation
  | { t: 'error'; code: string; message: string }
  | { t: 'kick'; reason: string }; // anti-cheat / timeout

// ---- gameplay payloads -------------------------------------------------------
interface ScoreSnapshot {
  // ~a throttled view of Judge state (§2)
  seq: number; // judge.judgmentSeq — for ordering/dedupe
  atSong: number; // this client's song-seconds at emit (context only)
  percent: number; // judge.percentDancePoints (0..1)
  combo: number;
  maxCombo: number;
  life: number; // 0..1
  failed: boolean;
  counts: JudgmentCounts; // running judge.tapCounts
}

interface PlayResult {
  // final; mirrors app/scores.ts RecordInput
  percent: number;
  grade: string; // 'AAA' | 'AA' | ...
  maxCombo: number;
  failed: boolean;
  counts: JudgmentCounts;
  holdCounts: JudgmentCounts;
}

// ---- lobby payloads ----------------------------------------------------------
interface UserSummary {
  id: UserId;
  name: string;
  ready: boolean;
  haveChart: boolean;
}
interface RoomState {
  id: RoomId;
  name: string;
  users: UserSummary[];
  conditions: PlayConditions;
  chart: ChartRef | null;
  phase: 'lobby' | 'loading' | 'playing' | 'results';
}
interface Standing {
  user: UserId;
  name: string;
  place: number;
  result: PlayResult;
}
```

Async-leaderboard messages (HTTP, not WS) reuse the same `PlayResult` + `ChartRef`:

```ts
// POST /leaderboard/submit
interface SubmitScore {
  chart: ChartRef;
  conditions: PlayConditions;
  result: PlayResult;
  ghost?: GhostFrame[];
  nonce: string;
}
// GET  /leaderboard?chartKey=..&rate=..  ->
interface LeaderboardRow {
  rank: number;
  name: string;
  percent: number;
  grade: string;
  maxCombo: number;
  at: number;
  hasGhost: boolean;
}

/** Optional compact replay for the "race a ghost" mode (mode 1 in §3). */
interface GhostFrame {
  atSong: number;
  percent: number;
  combo: number;
  life: number;
}
```

Wiring into existing code is small: a `NetSession` observes the live `Judge`
(emitting `scoreUpdate` off `judgmentSeq` changes), and `session.onEnd(judge)`
(already the single completion hook in `Play.tsx`) builds the `PlayResult` and
sends `finish` — the same `judge` fields already feed `recordPlay`.

---

## 7. Phased plan

Each phase ends with something demoable and reuses the prior phase's transport.

- **M1 — Async leaderboards & ghosts.** WS/HTTP server + a `chartHash` (M6 in the
  main roadmap already plans `ChartKey` hashing). On `onEnd`, submit
  `PlayResult`; add a leaderboard view keyed by `chartKey` + rate; optional ghost
  capture (`GhostFrame[]`) and a "race the ghost" bar in `Play.tsx`. **No live
  connection needed during play** → most robust, ships first, works offline
  (queue + retry). This is the GrooveStats-equivalent and the safe MVP.

- **M2 — Rooms, roster, chat, spectate.** Stand up the lobby: `createRoom` /
  `joinRoom` / `roster` / `chat`, and a read-only **spectate** view that renders a
  remote `scoreUpdate` stream (no local judging). Proves the WS relay,
  presence/disconnect handling, and the live-bar renderer before any timing
  coordination.

- **M3 — Real-time synchronized versus.** Add `ready`/`loaded` → server `start`
  with `startAt` (§5.2) + clock-offset estimation (§5.1). Each client judges
  locally and streams `scoreUpdate`; render everyone's **life + score + combo
  bars**; `matchOver` → combined results. Lock `chartHash`/rate/mods for ranked.
  This is the SMOnline experience on the web.

- **M4 — Rooms/chat polish + anti-cheat hardening.** Persistent rooms, invites,
  rematch, rate/mod pickers; server-side referee (§6/§8), rate-limited chat, ban
  list, ranked vs. casual boards, and (optionally) a WebRTC data-channel fast
  path for friendly rooms.

### Reuse vs. build

- **Build a fresh Node WS server.** ITGmania's classic TCP/binary SMOnline server
  is **not** reachable from a browser and its sources are gone from this tree; a
  browser cannot open raw TCP. Bridging to an old SMOnline server would mean a
  translating proxy (TCP↔WS, binary↔JSON, and reconstructing removed screens) for
  a protocol we would not otherwise want. Not worth it.
- **Bridge to GrooveStats for M1 leaderboards?** Its API is HTTP and precisely the
  async model we want, and ITGmania already talks to it via `NetworkManager`. But
  it is ITG-content/hash oriented and third-party; **use it as a design
  reference** (per-rate boards, hash-keyed charts, queued submit) and run our own
  endpoints so we control schema, ranking, and non-ITG content. Keep the door
  open to _also_ submit to GrooveStats later for charts it recognizes.
- **Reuse Stepzone internals directly.** `Judge` already exposes exactly the
  scoreboard state; `chartKey` is a leaderboard key; `onEnd(judge)` is the single
  finish hook; the 2 s lead-in is a countdown handle; `SyncMap`/`getOutputTimestamp`
  is the anchor for converting `startAt` to a local `when`. Very little new
  gameplay code — mostly a `NetSession` adapter + UI.

---

## 8. Security, cheating, NAT & hosting

### 8.1 Cheating (the hard, unavoidable problem)

Authoritative-local means the client _is_ the referee for its own score, so a
modified web client can submit anything. The web makes this worse (open
DevTools). You cannot fully prevent it; you **raise cost** and **detect
implausibility**:

- **Server sanity/referee checks** on every `scoreUpdate`/`finish`:
  monotonic `seq`/counts (never decrease), counts ≤ note count of the (hashed)
  chart, `percent` consistent with `counts` under the known scoring weights
  (`src/gameplay/scoring.ts` is deterministic — the server can recompute % from
  counts and reject mismatches), life/combo transitions physically possible,
  finish arrives no earlier than the chart length ÷ rate after `startAt`.
- **Chart hashing** (`chartHash`) so scores bind to an exact chart; reject
  unknown/edited charts on ranked boards.
- **Replay/ghost as proof.** Requiring a `GhostFrame[]` (or a fuller input replay)
  for top ranked scores lets the server (or a re-judge job) validate the score is
  reproducible; bot-perfect timing distributions are also flaggable.
- **Rate/mod lock** for ranked (§5.4); partition boards by conditions.
- **Anti-abuse plumbing:** authenticated accounts for ranked, per-connection rate
  limits (chat + score msgs), nonces on submissions to stop replay-resubmission,
  ban/kick, and treat _all_ client input as hostile server-side.
- Accept residual risk: **casual/friendly rooms are for fun** (best-effort), and
  ranked leans on accounts + replay validation + statistical anomaly detection.
  This is strictly _more_ than classic SMOnline (which had none).

### 8.2 Privacy / abuse

Chat needs server-side rate limiting, length caps, and moderation hooks; do not
leak IPs between peers (another reason to keep WebRTC out of the base path —
P2P exposes IPs). Names are user-chosen; ranked identity is the account.

### 8.3 NAT & hosting

- **WS relay = no client NAT issues.** Every client dials **out** to `wss://…`;
  the server needs one public TLS endpoint (behind a normal reverse proxy). This
  is the SMOnline dial-out topology and the main reason to prefer the relay.
- **WebRTC (if added) reintroduces NAT:** needs STUN, and TURN relay for
  symmetric-NAT pairs — recurring bandwidth cost, and it exposes peer IPs. Another
  reason it is an opt-in fast path, not the base.
- **Scaling:** the relay is I/O-bound and horizontally shardable by room; a single
  small node handles many rooms since payloads are tiny (§5.3). Leaderboards are a
  small DB (Postgres/SQLite) behind the same origin.
- **Hosting shape:** one Node process (WS + HTTP leaderboard API) + a database +
  TLS termination. Cheap. `NetworkManager`'s allow-host preference is a reminder
  to pin the server origin client-side.

---

## 9. Summary

- **Model:** authoritative-local (StepMania's model, and the only one the web's
  two-timebase clock allows) — each client judges its own input on its own audio
  clock and broadcasts only derived stats.
- **Transport:** a Node **WebSocket relay + referee** carrying lobby, chat, the
  shared-start timestamp, and the live stat stream (JSON); WebRTC data channels
  are a later, opt-in fast path with real NAT/anti-cheat/complexity costs.
- **Sync:** NTP-style clock-offset estimate → server issues "start at `T0`" →
  each client lands song-second 0 on `T0` via its `getOutputTimestamp` anchor;
  only aggregate stats cross the wire; rate/mods locked for ranked.
- **Phases:** M1 async leaderboards/ghosts → M2 rooms + chat + spectate → M3
  real-time versus with live life/score bars → M4 rooms polish + anti-cheat
  hardening.
- **Build, don't bridge:** the classic ITGmania TCP netcode is gone and
  browser-unreachable; stand up a fresh WS server, reuse GrooveStats only as a
  design reference for async boards, and lean on Stepzone's existing
  `Judge`/`chartKey`/`onEnd` seams.
