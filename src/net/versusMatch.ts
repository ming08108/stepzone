/**
 * The versus match controller — one instance per player, symmetric except for
 * the HOST flag. Runs the whole match flow over any string channel (the real
 * RTCDataChannel in the app, fakes in tests):
 *
 *   hello ⇄ hello        both sides announce names        -> lobby
 *   ready ⇄ ready        both confirm on the ready screen
 *   host: load ->        both prepare their GameSession   -> loading
 *   loaded ⇄ loaded      audio decoded, GPU ready
 *   host: ping/pong      one RTT probe
 *   host: go(D)          joiner begins after D; host after D + rtt/2, so both
 *                        start on the same wall instant   -> countdown
 *   snap ⇄ snap          live scoreboard stream while playing
 *   finish ⇄ finish      final results                    -> done
 *
 * Judging never crosses the wire — each side judges its own input and shares
 * derived stats only (docs/ONLINE-MULTIPLAYER.md §2). A dropped channel after
 * 'go' is not fatal: the local player keeps playing and the opponent shows as
 * disconnected.
 */

import type { PlayResult } from './protocol';
import {
  parsePeerMsg,
  type PeerMsg,
  type VersusChartMeta,
  type VersusNote,
  type VersusSnap,
} from './versus';

/** Transport seam: the app passes an RTCDataChannel adapter, tests pass fakes. */
export interface PeerChannel {
  send(data: string): void;
  close(): void;
}

export type MatchPhase = 'connecting' | 'lobby' | 'loading' | 'playing' | 'done';

export interface OpponentState {
  name: string | null;
  ready: boolean;
  /** Their chart choice: advisory while browsing, PINNED by their ready frame. */
  pick: VersusChartMeta | null;
  loaded: boolean;
  snap: VersusSnap | null;
  result: PlayResult | null;
  /** Channel closed (or bye) — DNF if it happened mid-match. */
  left: boolean;
}

/** How far in the future the host schedules the shared start. */
const GO_LEAD_MS = 800;

export class VersusMatch {
  phase: MatchPhase = 'connecting';
  readonly opponent: OpponentState = {
    name: null,
    ready: false,
    pick: null,
    loaded: false,
    snap: null,
    result: null,
    left: false,
  };
  /** Host's measured round trip (0 until probed; joiner never measures). */
  rttMs = 0;

  /** The rival's judged notes in arrival order — the rival-playfield feed.
   *  Append-only; consumers keep their own read cursor (no callbacks needed:
   *  the field polls each frame anyway). Capped against hostile flooding. */
  readonly opponentNotes: VersusNote[] = [];

  /** Any observable state changed (phase, opponent fields). */
  onUpdate?: () => void;
  /** Both players are ready — prepare the session, then call loaded(). */
  onLoadRequested?: () => void;
  /** Begin gameplay in `delayMs` (already latency-compensated). */
  onGo?: (delayMs: number) => void;

  private selfReady = false;
  private selfPickValue: VersusChartMeta | null = null;
  private selfLoaded = false;
  private selfResult: PlayResult | null = null;
  private snapSeq = 0;
  private pingSentAt = 0;
  private closed = false;

  constructor(
    private readonly channel: PeerChannel,
    private readonly opts: { isHost: boolean; name: string; now?: () => number },
  ) {
    this.send({ t: 'hello', name: opts.name });
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private send(msg: PeerMsg): void {
    if (this.closed) return;
    try {
      this.channel.send(JSON.stringify(msg));
    } catch {
      // Channel died mid-send; the close handler will mark the opponent gone.
    }
  }

  private update(): void {
    this.onUpdate?.();
  }

  /** Wire the transport's message events here (raw string frames). */
  handleMessage(raw: string): void {
    const msg = parsePeerMsg(raw);
    if (!msg) return; // hostile/garbled peer input is dropped, never fatal
    switch (msg.t) {
      case 'hello':
        this.opponent.name = msg.name;
        if (this.phase === 'connecting') this.phase = 'lobby';
        this.update();
        break;
      case 'pick':
        // Advisory while browsing; a repick after their ready frame is
        // hostile/duplicate and must not unpin the committed choice.
        if (!this.opponent.ready) {
          this.opponent.pick = msg.pick;
          this.update();
        }
        break;
      case 'ready':
        this.opponent.ready = true;
        this.opponent.pick = msg.pick; // the frame that counts (ordered channel)
        this.maybeRequestLoad();
        this.update();
        break;
      case 'load':
        // Host decided both are ready (host never receives this).
        if (!this.opts.isHost && this.phase === 'lobby') this.startLoading();
        break;
      case 'loaded':
        this.opponent.loaded = true;
        this.maybeGo();
        this.update();
        break;
      case 'ping':
        this.send({ t: 'pong', at: msg.at });
        break;
      case 'pong':
        if (this.opts.isHost && msg.at === this.pingSentAt) {
          this.rttMs = Math.max(0, this.now() - msg.at);
          this.issueGo();
        }
        break;
      case 'go':
        if (!this.opts.isHost && this.phase === 'loading') {
          this.phase = 'playing';
          this.onGo?.(msg.delayMs);
          this.update();
        }
        break;
      case 'snap':
        if (!this.opponent.snap || msg.snap.seq > this.opponent.snap.seq) {
          this.opponent.snap = msg.snap;
          this.update();
        }
        break;
      case 'notes':
        if (this.opponentNotes.length < 100_000) this.opponentNotes.push(...msg.notes);
        break; // no update(): the field polls on its own frame loop
      case 'finish':
        this.opponent.result = msg.result;
        this.maybeDone();
        this.update();
        break;
      case 'bye':
        this.handleClose();
        break;
    }
  }

  /** Wire the transport's close/error events here. */
  handleClose(): void {
    if (this.opponent.left) return;
    this.opponent.left = true;
    // Before the match starts, a vanished peer ends the room; mid-match the
    // local player keeps playing and the opponent just reads DISCONNECTED.
    if (this.phase === 'lobby' || this.phase === 'connecting' || this.phase === 'loading') {
      this.phase = 'done';
    }
    this.maybeDone();
    this.update();
  }

  // ---- local player actions ------------------------------------------------------

  /** Broadcast the chart being browsed (lobby display only; no-op once ready). */
  sendPick(pick: VersusChartMeta): void {
    if (this.selfReady || (this.phase !== 'lobby' && this.phase !== 'connecting')) return;
    this.selfPickValue = pick;
    this.send({ t: 'pick', pick });
  }

  /** The local player confirmed — pins their chart pick in the same frame. */
  ready(pick: VersusChartMeta): void {
    if (this.selfReady || this.phase !== 'lobby') return;
    this.selfReady = true;
    this.selfPickValue = pick;
    this.send({ t: 'ready', pick });
    this.maybeRequestLoad();
    this.update();
  }

  get selfPick(): VersusChartMeta | null {
    return this.selfPickValue;
  }

  /** The local session finished prepare() (audio decoded, GPU up). */
  loaded(): void {
    if (this.selfLoaded || this.phase !== 'loading') return;
    this.selfLoaded = true;
    this.send({ t: 'loaded' });
    this.maybeGo();
  }

  /** Stream one scoreboard sample (call at a few Hz while playing). */
  sendSnap(snap: Omit<VersusSnap, 'seq'>): void {
    if (this.phase !== 'playing') return;
    this.send({ t: 'snap', snap: { ...snap, seq: ++this.snapSeq } });
  }

  /** Stream freshly-judged notes (display feed for the rival's playfield). */
  sendNotes(notes: VersusNote[]): void {
    if (this.phase !== 'playing' || notes.length === 0) return;
    // The parser caps a frame at 512 notes; batches are tiny in practice.
    for (let at = 0; at < notes.length; at += 512) {
      this.send({ t: 'notes', notes: notes.slice(at, at + 512) });
    }
  }

  /** The local play ended (natural finish or fail). */
  finish(result: PlayResult): void {
    if (this.selfResult) return;
    this.selfResult = result;
    this.send({ t: 'finish', result });
    this.maybeDone();
    this.update();
  }

  /** Leave the room/match; closes the channel. */
  leave(): void {
    this.send({ t: 'bye' });
    this.closed = true;
    try {
      this.channel.close();
    } catch {
      // already closed
    }
  }

  get selfIsReady(): boolean {
    return this.selfReady;
  }

  /** Final standings once done: [you, them] results as known. */
  get results(): { self: PlayResult | null; opponent: PlayResult | null } {
    return { self: this.selfResult, opponent: this.opponent.result };
  }

  // ---- host coordination -----------------------------------------------------------

  private maybeRequestLoad(): void {
    if (!this.opts.isHost || this.phase !== 'lobby') return;
    if (this.selfReady && this.opponent.ready) {
      this.send({ t: 'load' });
      this.startLoading();
    }
  }

  private startLoading(): void {
    this.phase = 'loading';
    this.onLoadRequested?.();
    this.update();
  }

  private maybeGo(): void {
    if (!this.opts.isHost || this.phase !== 'loading') return;
    if (this.selfLoaded && this.opponent.loaded) {
      // One RTT probe; the pong handler issues the go.
      this.pingSentAt = this.now();
      this.send({ t: 'ping', at: this.pingSentAt });
    }
  }

  private issueGo(): void {
    if (this.phase !== 'loading') return;
    this.phase = 'playing';
    // The joiner receives 'go' half an RTT from now and waits GO_LEAD_MS; the
    // host waits GO_LEAD_MS plus that half RTT, landing both on one instant.
    this.send({ t: 'go', delayMs: GO_LEAD_MS });
    this.onGo?.(GO_LEAD_MS + this.rttMs / 2);
    this.update();
  }

  private maybeDone(): void {
    if (this.phase !== 'playing') return;
    const opponentSettled = this.opponent.result !== null || this.opponent.left;
    if (this.selfResult && opponentSettled) {
      this.phase = 'done';
    }
  }
}
