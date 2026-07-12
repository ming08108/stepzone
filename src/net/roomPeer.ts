/**
 * The room controllers — RoomHost (the hub) and RoomGuest (a spoke), sharing
 * one observable surface (RoomPeer) so the UI never cares which end it holds.
 * Runs the whole persistent-room flow over any string channel (real
 * RTCDataChannels in the app, fakes in tests):
 *
 *   guest: hello        host: welcome + roster (+ current song)
 *   host: song(seq)     a new cycle — picks/ready/results reset
 *   ready ⇄ roster      everyone pins a difficulty (all ready -> load)
 *   loaded …            sessions prepared (audio decoded, GPU up)
 *   host: ping/pong     one RTT probe per guest
 *   host: go(D_i)       per-guest half-RTT-compensated delays land every
 *                       machine on ONE wall instant
 *   snap/notes ⇄ p*     live streams, relayed hub-and-spoke
 *   finish ⇄ pfinish    all racers settled -> back to lobby, room intact
 *
 * Judging never crosses the wire — each player judges their own input and
 * shares derived stats only (docs/ONLINE-MULTIPLAYER.md §2). A guest dropping
 * mid-song is a DNF, not a room end; the HOST dropping ends the room (star
 * topology — there is nothing to relay through anymore).
 */

import type { PlayResult } from './protocol';
import {
  MAX_PLAYERS,
  parseGuestMsg,
  parseHostMsg,
  ROOM_PROTOCOL,
  type GuestMsg,
  type HostMsg,
  type RoomPhase,
  type RosterPlayer,
  type TransferBinary,
  type VersusChartMeta,
  type VersusNote,
  type VersusSnap,
  type VersusSongRef,
} from './versus';

/** Transport seam: the app passes RTCDataChannel adapters, tests pass fakes. */
export interface PeerChannel {
  send(data: string): void;
  close(): void;
}

/** One player as the local end sees them (self included, keyed by id). */
export interface PlayerState {
  id: number;
  name: string;
  pick: VersusChartMeta | null;
  ready: boolean;
  done: boolean;
  left: boolean;
  /** Latest live scoreboard sample while playing. */
  snap: VersusSnap | null;
  /** Final result for the current song (kept until the next song starts). */
  result: PlayResult | null;
  /** Their judged-note display feed, append-only; consumers keep a cursor. */
  notes: VersusNote[];
}

/** Feeds are display-only; cap them so a hostile peer can't grow memory. */
const MAX_NOTE_FEED = 100_000;
/** How far in the future the host schedules the shared start. */
const GO_LEAD_MS = 800;

export type RoomClosedReason = 'host-left' | 'full' | 'version' | 'connection';

export interface FileMetaMsg {
  simfileName: string;
  simfile: string;
  files: TransferBinary[];
}

function newPlayer(id: number, name: string): PlayerState {
  return {
    id,
    name,
    pick: null,
    ready: false,
    done: false,
    left: false,
    snap: null,
    result: null,
    notes: [],
  };
}

/**
 * The common observable surface + local-player actions. Everything the UI
 * (roomStore, PLAYER OPTIONS dock, Play) consumes goes through this shape.
 */
export abstract class RoomPeer {
  abstract readonly isHost: boolean;
  abstract readonly selfId: number;
  /** The arrow code (host: from signaling; guest: from welcome). */
  abstract readonly code: string;

  phase: RoomPhase = 'lobby';
  song: VersusSongRef | null = null;
  musicRate = 1;
  /** Monotonic per-song-broadcast sequence; actions echo it (stale = dropped). */
  protected songSeq = 0;
  /** True once the room is over (host gone / kicked / left) — terminal. */
  ended = false;

  protected readonly playerMap = new Map<number, PlayerState>();

  /** Any observable state changed (phase, roster, players, song). */
  onUpdate?: () => void;
  /** The host set (or cleared) the song for a new cycle. Guests follow it. */
  onSong?: (song: VersusSongRef | null, musicRate: number) => void;
  /** Everyone is ready — prepare the session, then call loaded(). */
  onLoadRequested?: () => void;
  /** Begin gameplay in `delayMs` (already latency-compensated). */
  onGo?: (delayMs: number) => void;
  /** The room is gone for good (terminal; fires at most once). */
  onClosed?: (reason: RoomClosedReason) => void;
  /** Lobby: the host is browsing this song (guests only). */
  onBrowsing?: (title: string, artist: string) => void;
  /** Lobby: someone suggested a song (host: from a guest; guests: relayed). */
  onSuggested?: (name: string, title: string, artist: string) => void;

  /** Roster in id order (host first). */
  get players(): PlayerState[] {
    return [...this.playerMap.values()].sort((a, b) => a.id - b.id);
  }

  get self(): PlayerState | undefined {
    return this.playerMap.get(this.selfId);
  }

  /** Present (non-left) players. */
  protected active(): PlayerState[] {
    return this.players.filter((p) => !p.left);
  }

  protected update(): void {
    this.onUpdate?.();
  }

  protected end(reason: RoomClosedReason): void {
    if (this.ended) return;
    this.ended = true;
    this.onClosed?.(reason);
    this.update();
  }

  protected appendNotes(p: PlayerState, notes: VersusNote[]): void {
    const room = MAX_NOTE_FEED - p.notes.length;
    if (room > 0) p.notes.push(...(notes.length > room ? notes.slice(0, room) : notes));
  }

  // ---- local player actions (implemented per end) --------------------------------
  abstract sendPick(pick: VersusChartMeta): void;
  abstract ready(pick: VersusChartMeta): void;
  abstract loaded(): void;
  abstract sendSnap(snap: Omit<VersusSnap, 'seq'>): void;
  abstract sendNotes(notes: VersusNote[]): void;
  abstract finish(result: PlayResult): void;
  /** Leave the room (terminal for this end; the room may live on for others). */
  abstract leave(): void;
}

// ---- host ------------------------------------------------------------------------

interface GuestSlot {
  id: number;
  channel: PeerChannel;
  helloed: boolean;
  loaded: boolean;
  /** RTT probe bookkeeping for the current cycle. */
  pingAt: number;
  rttMs: number | null;
}

export class RoomHost extends RoomPeer {
  readonly isHost = true;
  readonly selfId = 0;

  /** The current cycle's racers (ids captured when load was issued). */
  private racers = new Set<number>();
  private selfLoaded = false;
  private snapSeq = 0;
  private nextGuestId = 1;
  private readonly guests = new Map<number, GuestSlot>();

  /** A guest asked for the current song's files (serve over ITS channel). */
  onFileReq?: (guestId: number) => void;
  /** The guest we asked to become the new host has opened its room and reported
   *  the code — the store now sends everyone there (host handoff). */
  onHostReady?: (code: string) => void;
  /** The guest currently being promoted to host (only its hostReady counts). */
  private promotedId = -1;

  constructor(
    readonly code: string,
    private readonly opts: { name: string; now?: () => number },
  ) {
    super();
    this.playerMap.set(0, newPlayer(0, opts.name));
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * Wire a fresh guest channel in. Returns the assigned guest id — the caller
   * keeps the id -> connection map for binary file streaming. The guest is
   * roster-visible only once its hello lands.
   */
  attachGuest(channel: PeerChannel): number {
    const id = this.nextGuestId++;
    this.guests.set(id, { id, channel, helloed: false, loaded: false, pingAt: 0, rttMs: null });
    return id;
  }

  /** Wire the transport's message/close events for one attached guest. */
  handleGuestMessage(id: number, raw: string): void {
    const slot = this.guests.get(id);
    if (!slot || this.ended) return;
    const msg = parseGuestMsg(raw);
    if (!msg) return; // hostile/garbled input is dropped, never fatal
    if (!slot.helloed) {
      if (msg.t !== 'hello') return; // nothing counts before hello
      this.admitGuest(slot, msg);
      return;
    }
    const p = this.playerMap.get(id);
    if (!p || p.left) return;
    switch (msg.t) {
      case 'hello':
        break; // duplicate — ignore
      case 'pick':
        if (msg.seq === this.songSeq && !p.ready) {
          p.pick = msg.pick;
          this.broadcastRoster();
          this.update();
        }
        break;
      case 'ready':
        if (msg.seq === this.songSeq && this.phase === 'lobby' && !p.ready) {
          p.ready = true;
          p.pick = msg.pick;
          this.broadcastRoster();
          this.maybeLoad();
          this.update();
        }
        break;
      case 'loaded':
        if (msg.seq === this.songSeq && this.phase === 'loading' && this.racers.has(id)) {
          slot.loaded = true;
          this.maybeProbe();
        }
        break;
      case 'pong':
        if (this.phase === 'loading' && msg.at === slot.pingAt && slot.rttMs === null) {
          slot.rttMs = Math.max(0, this.now() - msg.at);
          this.maybeGo();
        }
        break;
      case 'snap':
        // Only enrolled racers stream — a spectator can't inject a fake
        // scoreboard for its id, and the host won't amplify it to everyone.
        if (
          this.phase === 'playing' &&
          this.racers.has(id) &&
          (!p.snap || msg.snap.seq > p.snap.seq)
        ) {
          p.snap = msg.snap;
          this.relayExcept(id, { t: 'psnap', id, snap: msg.snap });
          this.update();
        }
        break;
      case 'notes':
        if (this.phase === 'playing' && this.racers.has(id)) {
          this.appendNotes(p, msg.notes);
          this.relayExcept(id, { t: 'pnotes', id, notes: msg.notes });
        }
        break;
      case 'finish':
        if (msg.seq === this.songSeq && this.racers.has(id) && !p.done) {
          p.done = true;
          p.result = msg.result;
          this.relayExcept(id, { t: 'pfinish', id, result: msg.result });
          this.broadcastRoster();
          this.maybeCycleEnd();
          this.update();
        }
        break;
      case 'fileReq':
        this.onFileReq?.(id);
        break;
      case 'hostReady':
        // Only the guest we actually promoted can redirect the room.
        if (id === this.promotedId) this.onHostReady?.(msg.code);
        break;
      case 'suggest':
        // Show it to the host and relay to everyone else so the room agrees.
        this.onSuggested?.(p.name, msg.title, msg.artist);
        this.relayExcept(id, {
          t: 'suggested',
          name: p.name,
          title: msg.title,
          artist: msg.artist,
        });
        break;
      case 'bye':
        this.handleGuestClose(id);
        break;
    }
  }

  /** Wire the transport's close/error events for one attached guest. */
  handleGuestClose(id: number): void {
    const slot = this.guests.get(id);
    if (!slot) return;
    this.guests.delete(id);
    try {
      slot.channel.close();
    } catch {
      // already closed
    }
    const p = this.playerMap.get(id);
    if (!p || p.left) return;
    p.left = true;
    // In the lobby a leaver just vanishes; mid-song they stay as a DNF row.
    if (this.phase === 'lobby') this.playerMap.delete(id);
    // Nobody left to race with: stop holding the host's pinned ready.
    if (this.phase === 'lobby' && this.active().length < 2) {
      for (const q of this.playerMap.values()) q.ready = false;
    }
    this.broadcastRoster();
    // A racer vanishing may be the last thing a gate was waiting on.
    this.maybeProbe();
    this.maybeGo();
    this.maybeCycleEnd();
    this.update();
  }

  private admitGuest(slot: GuestSlot, hello: GuestMsg & { t: 'hello' }): void {
    if (hello.v !== ROOM_PROTOCOL) {
      this.sendTo(slot, { t: 'err', reason: 'version' });
      this.dropSlot(slot.id);
      return;
    }
    if (this.active().length >= MAX_PLAYERS) {
      this.sendTo(slot, { t: 'err', reason: 'full' });
      this.dropSlot(slot.id);
      return;
    }
    slot.helloed = true;
    this.playerMap.set(slot.id, newPlayer(slot.id, hello.name));
    this.sendTo(slot, { t: 'welcome', v: ROOM_PROTOCOL, you: slot.id, code: this.code });
    if (this.song) {
      this.sendTo(slot, {
        t: 'song',
        seq: this.songSeq,
        song: this.song,
        musicRate: this.musicRate,
      });
    }
    this.broadcastRoster();
    this.update();
  }

  private dropSlot(id: number): void {
    const slot = this.guests.get(id);
    if (!slot) return;
    this.guests.delete(id);
    try {
      slot.channel.close();
    } catch {
      // already closed
    }
  }

  private sendTo(slot: GuestSlot, msg: HostMsg): void {
    try {
      slot.channel.send(JSON.stringify(msg));
    } catch {
      // channel died mid-send; its close handler will clean up
    }
  }

  private broadcast(msg: HostMsg): void {
    const raw = JSON.stringify(msg);
    for (const slot of this.guests.values()) {
      if (!slot.helloed) continue;
      try {
        slot.channel.send(raw);
      } catch {
        // close handler cleans up
      }
    }
  }

  private relayExcept(fromId: number, msg: HostMsg): void {
    const raw = JSON.stringify(msg);
    for (const slot of this.guests.values()) {
      if (!slot.helloed || slot.id === fromId) continue;
      try {
        slot.channel.send(raw);
      } catch {
        // close handler cleans up
      }
    }
  }

  private roster(): RosterPlayer[] {
    return this.players.map((p) => ({
      id: p.id,
      name: p.name,
      pick: p.pick,
      ready: p.ready,
      done: p.done,
      left: p.left,
    }));
  }

  private broadcastRoster(): void {
    this.broadcast({ t: 'roster', phase: this.phase, players: this.roster() });
  }

  // ---- host actions ----------------------------------------------------------------

  /** Start a new cycle on this song (host landed on PLAYER OPTIONS with it). */
  setSong(song: VersusSongRef, musicRate: number): void {
    if (this.ended || this.phase !== 'lobby') return;
    this.songSeq++;
    this.song = song;
    this.musicRate = musicRate;
    this.resetCycle();
    this.broadcast({ t: 'song', seq: this.songSeq, song, musicRate });
    this.broadcastRoster();
    this.update();
  }

  /** The host backed out of PLAYER OPTIONS — no song on the table. */
  clearSong(): void {
    if (this.ended || this.phase !== 'lobby' || !this.song) return;
    this.songSeq++;
    this.song = null;
    this.resetCycle();
    this.broadcast({ t: 'song', seq: this.songSeq, song: null, musicRate: this.musicRate });
    this.broadcastRoster();
    this.update();
  }

  private resetCycle(): void {
    this.racers.clear();
    this.selfLoaded = false;
    for (const p of this.playerMap.values()) {
      if (p.left) this.playerMap.delete(p.id); // DNF rows served their purpose
      p.pick = null;
      p.ready = false;
      p.done = false;
      p.snap = null;
      p.result = null;
      p.notes = [];
    }
    for (const slot of this.guests.values()) {
      slot.loaded = false;
      slot.pingAt = 0;
      slot.rttMs = null;
    }
  }

  sendPick(pick: VersusChartMeta): void {
    const self = this.self;
    if (this.ended || !self || self.ready || this.phase !== 'lobby') return;
    self.pick = pick;
    this.broadcastRoster();
    this.update();
  }

  ready(pick: VersusChartMeta): void {
    const self = this.self;
    if (this.ended || !self || self.ready || this.phase !== 'lobby' || !this.song) return;
    self.ready = true;
    self.pick = pick;
    this.broadcastRoster();
    this.maybeLoad();
    this.update();
  }

  loaded(): void {
    if (this.selfLoaded || this.phase !== 'loading') return;
    this.selfLoaded = true;
    this.maybeProbe();
  }

  sendSnap(snap: Omit<VersusSnap, 'seq'>): void {
    const self = this.self;
    if (this.phase !== 'playing' || !self) return;
    const full: VersusSnap = { ...snap, seq: ++this.snapSeq };
    self.snap = full;
    this.broadcast({ t: 'psnap', id: 0, snap: full });
    this.update();
  }

  sendNotes(notes: VersusNote[]): void {
    if (this.phase !== 'playing' || notes.length === 0) return;
    // The parser caps a frame at 512 notes; batches are tiny in practice.
    for (let at = 0; at < notes.length; at += 512) {
      this.broadcast({ t: 'pnotes', id: 0, notes: notes.slice(at, at + 512) });
    }
  }

  finish(result: PlayResult): void {
    const self = this.self;
    if (!self || self.done || !this.racers.has(0)) return;
    self.done = true;
    self.result = result;
    this.broadcast({ t: 'pfinish', id: 0, result });
    this.broadcastRoster();
    this.maybeCycleEnd();
    this.update();
  }

  /** Host handoff step 1: ask a present guest to open its own room and report
   *  back (lobby only — a race shouldn't be interrupted). */
  promote(id: number): void {
    if (this.ended || this.phase !== 'lobby' || id === 0) return;
    const slot = this.guests.get(id);
    const p = this.playerMap.get(id);
    if (!slot || !p || p.left) return;
    this.promotedId = id;
    this.sendTo(slot, { t: 'becomeHost' });
  }

  /** Host handoff step 3: send everyone (including the old host itself, via the
   *  store) to the new host's room, then this room is done. */
  sendMigrate(code: string): void {
    this.broadcast({ t: 'migrate', code });
  }

  /** Lobby: tell the room what song the host is currently browsing. */
  sendBrowsing(title: string, artist: string): void {
    if (this.ended || this.phase !== 'lobby') return;
    this.broadcast({ t: 'browsing', title, artist });
  }

  leave(): void {
    this.broadcast({ t: 'bye' });
    for (const slot of [...this.guests.values()]) this.dropSlot(slot.id);
    this.end('host-left');
  }

  // ---- file serving (control frames; the store streams the binary) -----------------

  sendFileMeta(guestId: number, meta: FileMetaMsg): void {
    const slot = this.guests.get(guestId);
    if (slot) this.sendTo(slot, { t: 'fileMeta', ...meta });
  }

  sendFileDone(guestId: number): void {
    const slot = this.guests.get(guestId);
    if (slot) this.sendTo(slot, { t: 'fileDone' });
  }

  sendFileErr(guestId: number, message: string): void {
    const slot = this.guests.get(guestId);
    if (slot) this.sendTo(slot, { t: 'fileErr', message });
  }

  // ---- cycle choreography ------------------------------------------------------------

  private maybeLoad(): void {
    if (this.phase !== 'lobby' || !this.song) return;
    const active = this.active();
    if (active.length < 2 || !active.every((p) => p.ready)) return;
    this.beginLoad(active);
  }

  /** Host override: start now with whoever is ready, leaving the rest to
   *  spectate and join the next cycle (a stuck/AFK player can't wedge the room
   *  forever). Host must be readied and at least one other player ready too. */
  forceStart(): void {
    if (this.ended || this.phase !== 'lobby' || !this.song || !this.self?.ready) return;
    const ready = this.active().filter((p) => p.ready);
    if (ready.length < 2) return;
    this.beginLoad(ready);
  }

  /** Lock the racer set and kick off the load/probe/go choreography. */
  private beginLoad(racers: PlayerState[]): void {
    this.racers = new Set(racers.map((p) => p.id));
    this.phase = 'loading';
    this.broadcastRoster();
    // Carry the racer ids so a guest whose `ready` raced this start (e.g. a host
    // force-start) self-excludes instead of loading into a race it isn't in.
    this.broadcast({ t: 'load', racers: [...this.racers] });
    this.onLoadRequested?.();
    this.update();
  }

  /** All racers' sessions are prepared -> probe each guest's RTT once. */
  private maybeProbe(): void {
    if (this.phase !== 'loading' || !this.selfLoaded) return;
    for (const id of this.racers) {
      if (id === 0) continue;
      const p = this.playerMap.get(id);
      if (p?.left) continue;
      if (!this.guests.get(id)?.loaded) return;
    }
    const at = this.now();
    let probing = false;
    for (const id of this.racers) {
      const slot = this.guests.get(id);
      if (!slot || this.playerMap.get(id)?.left) continue;
      if (slot.rttMs !== null || slot.pingAt !== 0) continue; // already probed
      slot.pingAt = at;
      this.sendTo(slot, { t: 'ping', at });
      probing = true;
    }
    if (!probing) this.maybeGo(); // every guest racer left — solo go
  }

  /** All pongs in -> issue per-guest delays that land on one wall instant. */
  private maybeGo(): void {
    if (this.phase !== 'loading' || !this.selfLoaded) return;
    const live: GuestSlot[] = [];
    for (const id of this.racers) {
      if (id === 0) continue;
      const slot = this.guests.get(id);
      if (!slot || this.playerMap.get(id)?.left) continue;
      if (!slot.loaded || slot.pingAt === 0 || slot.rttMs === null) return;
      live.push(slot);
    }
    this.phase = 'playing';
    // Everyone starts at T = send-instant + GO_LEAD + maxRtt/2: guest i's
    // frame arrives at +rtt_i/2, so it waits the remaining difference.
    const maxRtt = live.reduce((m, s) => Math.max(m, s.rttMs ?? 0), 0);
    for (const slot of live) {
      this.sendTo(slot, { t: 'go', delayMs: GO_LEAD_MS + (maxRtt - (slot.rttMs ?? 0)) / 2 });
    }
    this.broadcastRoster();
    this.onGo?.(GO_LEAD_MS + maxRtt / 2);
    this.update();
  }

  /** Every racer settled (result or gone) -> back to the lobby, room intact.
   *  Results stay on the players until the next song starts. */
  private maybeCycleEnd(): void {
    if (this.phase !== 'playing') return;
    for (const id of this.racers) {
      const p = this.playerMap.get(id);
      if (p && !p.left && !p.done) return;
    }
    this.phase = 'lobby';
    for (const p of this.playerMap.values()) {
      p.ready = false;
      p.snap = null;
    }
    for (const slot of this.guests.values()) {
      slot.loaded = false;
      slot.pingAt = 0;
      slot.rttMs = null;
    }
    this.selfLoaded = false;
    this.broadcastRoster();
    this.update();
  }
}

// ---- guest -----------------------------------------------------------------------

export class RoomGuest extends RoomPeer {
  readonly isHost = false;

  private youId: number | null = null;
  private roomCode = '';
  private selfReady = false;
  private selfLoadedFlag = false;
  private selfDone = false;
  /** onLoadRequested fired for the current cycle (rosters may carry the
   *  'loading' phase before the load frame arrives — this gates the callback,
   *  not the phase). */
  private loadRequested = false;
  private snapSeq = 0;
  private closed = false;

  /** Song transfer (guest side): control frames from the host. */
  onFileMeta?: (meta: FileMetaMsg) => void;
  onFileDone?: () => void;
  onFileErr?: (message: string) => void;
  /** The host chose us as the new host — open our own room (host handoff). */
  onBecomeHost?: () => void;
  /** The host handed off to a new room — reconnect to `code`. */
  onMigrate?: (code: string) => void;

  constructor(
    private readonly channel: PeerChannel,
    opts: { name: string },
  ) {
    super();
    this.send({ t: 'hello', v: ROOM_PROTOCOL, name: opts.name });
  }

  get selfId(): number {
    return this.youId ?? -1;
  }

  get code(): string {
    return this.roomCode;
  }

  /** True once the host's welcome landed (roster follows immediately). */
  get joined(): boolean {
    return this.youId !== null;
  }

  private send(msg: GuestMsg): void {
    if (this.closed) return;
    try {
      this.channel.send(JSON.stringify(msg));
    } catch {
      // channel died mid-send; the close handler will end the room
    }
  }

  /** Wire the transport's message events here (raw string frames). */
  handleMessage(raw: string): void {
    if (this.ended) return;
    const msg = parseHostMsg(raw);
    if (!msg) return;
    switch (msg.t) {
      case 'welcome':
        if (msg.v !== ROOM_PROTOCOL) {
          this.leave();
          this.end('version');
          return;
        }
        this.youId = msg.you;
        this.roomCode = msg.code;
        this.update();
        break;
      case 'err':
        this.closed = true;
        this.end(msg.reason);
        break;
      case 'roster':
        this.applyRoster(msg.phase, msg.players);
        break;
      case 'song':
        this.songSeq = msg.seq;
        this.song = msg.song;
        this.musicRate = msg.musicRate;
        // New cycle: local per-song state resets (mirrors the host's reset).
        this.selfReady = false;
        this.selfLoadedFlag = false;
        this.selfDone = false;
        this.loadRequested = false;
        for (const p of this.playerMap.values()) {
          p.snap = null;
          p.result = null;
          p.notes = [];
        }
        this.onSong?.(msg.song, msg.musicRate);
        this.update();
        break;
      case 'load':
        // Only load if the host actually enrolled us as a racer — a force-start
        // that raced our `ready` starts without us, and we must not wedge.
        if (!this.loadRequested && this.selfReady && msg.racers.includes(this.youId ?? -1)) {
          this.loadRequested = true;
          this.phase = 'loading';
          this.onLoadRequested?.();
          this.update();
        }
        break;
      case 'ping':
        this.send({ t: 'pong', at: msg.at });
        break;
      case 'go':
        if (this.phase !== 'playing') {
          this.phase = 'playing';
          this.onGo?.(msg.delayMs);
          this.update();
        }
        break;
      case 'psnap': {
        const p = this.playerMap.get(msg.id);
        if (p && (!p.snap || msg.snap.seq > p.snap.seq)) {
          p.snap = msg.snap;
          this.update();
        }
        break;
      }
      case 'pnotes': {
        const p = this.playerMap.get(msg.id);
        if (p) this.appendNotes(p, msg.notes);
        break; // no update(): the rival field polls on its own frame loop
      }
      case 'pfinish': {
        const p = this.playerMap.get(msg.id);
        if (p) {
          p.done = true;
          p.result = msg.result;
          this.update();
        }
        break;
      }
      case 'fileMeta':
        this.onFileMeta?.({ simfileName: msg.simfileName, simfile: msg.simfile, files: msg.files });
        break;
      case 'fileDone':
        this.onFileDone?.();
        break;
      case 'fileErr':
        this.onFileErr?.(msg.message);
        break;
      case 'becomeHost':
        this.onBecomeHost?.();
        break;
      case 'migrate':
        this.onMigrate?.(msg.code);
        break;
      case 'browsing':
        this.onBrowsing?.(msg.title, msg.artist);
        break;
      case 'suggested':
        this.onSuggested?.(msg.name, msg.title, msg.artist);
        break;
      case 'bye':
        this.closed = true;
        this.end('host-left');
        break;
    }
  }

  /** Wire the transport's close/error events here. */
  handleClose(): void {
    if (this.ended) return;
    this.closed = true;
    this.end('connection');
  }

  /** Roster is authoritative for names/flags; streams (snap/result/notes) are
   *  event-fed and survive on the persistent per-id PlayerState objects. */
  private applyRoster(phase: RoomPhase, players: RosterPlayer[]): void {
    this.phase = phase;
    const seen = new Set<number>();
    for (const r of players) {
      seen.add(r.id);
      let p = this.playerMap.get(r.id);
      if (!p) {
        p = newPlayer(r.id, r.name);
        this.playerMap.set(r.id, p);
      }
      p.name = r.name;
      p.pick = r.pick;
      p.ready = r.ready;
      p.done = r.done;
      p.left = r.left;
    }
    for (const id of [...this.playerMap.keys()]) {
      if (!seen.has(id)) this.playerMap.delete(id); // pruned by the host
    }
    this.update();
  }

  // ---- guest actions ---------------------------------------------------------------

  sendPick(pick: VersusChartMeta): void {
    if (this.ended || this.selfReady || this.phase !== 'lobby') return;
    this.send({ t: 'pick', seq: this.songSeq, pick });
  }

  ready(pick: VersusChartMeta): void {
    if (this.ended || this.selfReady || this.phase !== 'lobby' || !this.song) return;
    this.selfReady = true;
    const self = this.self;
    if (self) {
      self.ready = true;
      self.pick = pick;
    }
    this.send({ t: 'ready', seq: this.songSeq, pick });
    this.update();
  }

  loaded(): void {
    if (this.selfLoadedFlag || this.phase !== 'loading') return;
    this.selfLoadedFlag = true;
    this.send({ t: 'loaded', seq: this.songSeq });
  }

  sendSnap(snap: Omit<VersusSnap, 'seq'>): void {
    if (this.phase !== 'playing') return;
    const full: VersusSnap = { ...snap, seq: ++this.snapSeq };
    const self = this.self;
    if (self) self.snap = full;
    this.send({ t: 'snap', snap: full });
  }

  sendNotes(notes: VersusNote[]): void {
    if (this.phase !== 'playing' || notes.length === 0) return;
    for (let at = 0; at < notes.length; at += 512) {
      this.send({ t: 'notes', notes: notes.slice(at, at + 512) });
    }
  }

  finish(result: PlayResult): void {
    if (this.selfDone) return;
    this.selfDone = true;
    const self = this.self;
    if (self) {
      self.done = true;
      self.result = result;
    }
    this.send({ t: 'finish', seq: this.songSeq, result });
    this.update();
  }

  /** Ask the host for the current song's files (control frames come back via
   *  onFileMeta/onFileDone/onFileErr; binary chunks ride the channel raw). */
  requestFile(): void {
    if (this.ended) return;
    this.send({ t: 'fileReq' });
  }

  /** Host handoff step 2: we opened our own room — tell the old host its code so
   *  it can send everyone over. */
  reportHostCode(code: string): void {
    this.send({ t: 'hostReady', code });
  }

  /** Lobby: nudge the host toward a song (relayed to the whole room). */
  sendSuggest(title: string, artist: string): void {
    if (this.ended) return;
    this.send({ t: 'suggest', title, artist });
  }

  leave(): void {
    this.send({ t: 'bye' });
    this.closed = true;
    try {
      this.channel.close();
    } catch {
      // already closed
    }
  }
}
