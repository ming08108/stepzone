/**
 * The room flow, host and guests driven over an in-memory wire: the exact
 * message choreography (hello -> roster -> song -> ready -> load -> loaded ->
 * ping/pong -> go -> streams -> finish -> back to lobby) that runs on the
 * star-topology RTCDataChannels in the app.
 */
import { describe, expect, it } from 'vitest';
import type { PlayResult } from '../src/net/protocol';
import { RoomGuest, RoomHost, type PeerChannel } from '../src/net/roomPeer';
import {
  isRoomCode,
  MAX_PLAYERS,
  parseGuestMsg,
  parseHostMsg,
  randomRoomCode,
  type VersusChartMeta,
  type VersusSongRef,
} from '../src/net/versus';

const CODE = 'LDURLD';

/** A host plus N guests over buffering channels. flush() pumps EVERY wire
 *  until the whole mesh is quiet (relays create cross-wire traffic). */
function room(n: number, opts?: { hostNow?: () => number }) {
  const host = new RoomHost(CODE, { name: 'HOST', now: opts?.hostNow });
  const guests: RoomGuest[] = [];
  const steps: Array<() => boolean> = [];
  const flush = () => {
    for (let did = true; did;) {
      did = false;
      for (const step of steps) did = step() || did;
    }
  };
  const attach = (name: string): RoomGuest => {
    const toHost: string[] = [];
    const toGuest: string[] = [];
    let guest: RoomGuest | undefined;
    let closed = false;
    let id = -1;
    const step = () => {
      let did = false;
      while (toHost.length > 0) {
        host.handleGuestMessage(id, toHost.shift()!);
        did = true;
      }
      while (toGuest.length > 0 && guest) {
        guest.handleMessage(toGuest.shift()!);
        did = true;
      }
      return did;
    };
    // close() delivers in-flight frames first — an ordered reliable channel
    // flushes its send queue before tearing down, so a bye beats the close.
    const hostSide: PeerChannel = {
      send: (d) => {
        if (!closed) toGuest.push(d);
      },
      close: () => {
        if (closed) return;
        while (toGuest.length > 0 && guest) guest.handleMessage(toGuest.shift()!);
        closed = true;
        guest?.handleClose();
      },
    };
    const guestSide: PeerChannel = {
      send: (d) => {
        if (closed) throw new Error('closed');
        toHost.push(d);
      },
      close: () => {
        if (closed) return;
        while (toHost.length > 0) host.handleGuestMessage(id, toHost.shift()!);
        closed = true;
        host.handleGuestClose(id);
      },
    };
    id = host.attachGuest(hostSide);
    guest = new RoomGuest(guestSide, { name });
    steps.push(step);
    flush();
    return guest;
  };
  for (let g = 0; g < n; g++) guests.push(attach(`G${g + 1}`));
  return { host, guests, flush, addGuest: attach };
}

const pick = (meter = 5, difficulty = 3): VersusChartMeta => ({
  chartHash: 'hash-' + meter,
  stepsType: 'dance-single',
  difficulty,
  meter,
});

const song = (title = 'Song'): VersusSongRef => ({
  title,
  artist: 'Artist',
  charts: [pick(5), pick(8), pick(11)],
});

const result = (percent: number): PlayResult => ({
  percent,
  grade: 'A',
  maxCombo: 10,
  failed: false,
  counts: { 9: 10 },
  holdCounts: {},
});

/** Drive everyone through song -> ready -> loaded -> playing. */
function toPlaying(r: ReturnType<typeof room>) {
  const goDelays = new Map<string, number>();
  r.host.onGo = (d) => goDelays.set('HOST', d);
  r.guests.forEach((g, i) => (g.onGo = (d) => goDelays.set(`G${i + 1}`, d)));
  r.host.setSong(song(), 1);
  r.flush();
  r.host.ready(pick(5));
  r.guests.forEach((g, i) => g.ready(pick(5 + i)));
  r.flush();
  r.host.loaded();
  r.guests.forEach((g) => g.loaded());
  r.flush();
  return goDelays;
}

describe('room codes', () => {
  it('generates valid 6-arrow codes', () => {
    const code = randomRoomCode();
    expect(isRoomCode(code)).toBe(true);
    expect(code).toMatch(/^[LDUR]{6}$/);
    expect(isRoomCode('LDURL')).toBe(false); // too short
    expect(isRoomCode('LDURLX')).toBe(false); // bad symbol
  });
});

describe('room lobby', () => {
  it('admits guests into a shared roster with the host first', () => {
    const r = room(2);
    expect(r.host.players.map((p) => p.name)).toEqual(['HOST', 'G1', 'G2']);
    for (const g of r.guests) {
      expect(g.joined).toBe(true);
      expect(g.code).toBe(CODE);
      expect(g.players.map((p) => p.name)).toEqual(['HOST', 'G1', 'G2']);
    }
    expect(r.guests[0].selfId).toBe(1);
    expect(r.guests[1].selfId).toBe(2);
  });

  it('rejects guests past MAX_PLAYERS with a full error', () => {
    const r = room(MAX_PLAYERS - 1); // room now full including the host
    let reason = '';
    const extra = r.addGuest('EXTRA');
    extra.onClosed = (why) => (reason = why);
    r.flush();
    expect(extra.ended || reason === 'full').toBe(true);
    expect(r.host.players).toHaveLength(MAX_PLAYERS);
  });

  it('rejects a protocol-version mismatch', () => {
    const r = room(0);
    const sent: string[] = [];
    const id = r.host.attachGuest({ send: (d) => sent.push(d), close: () => {} });
    r.host.handleGuestMessage(id, JSON.stringify({ t: 'hello', v: 999, name: 'OLD' }));
    expect(sent.map((d) => JSON.parse(d).t)).toContain('err');
    expect(r.host.players).toHaveLength(1);
  });

  it('broadcasts the song to guests, including late joiners', () => {
    const r = room(1);
    const seen: Array<string | null> = [];
    r.guests[0].onSong = (s) => seen.push(s?.title ?? null);
    r.host.setSong(song('First'), 1.1);
    r.flush();
    expect(seen).toEqual(['First']);
    expect(r.guests[0].musicRate).toBe(1.1);
    // A guest joining after the pick hears about it immediately.
    const late = r.addGuest('LATE');
    expect(late.song?.title).toBe('First');
    // Clearing the song follows too.
    r.host.clearSong();
    r.flush();
    expect(seen).toEqual(['First', null]);
    expect(late.song).toBeNull();
  });

  it('shows advisory picks live and pins them on ready', () => {
    const r = room(1);
    r.host.setSong(song(), 1);
    r.flush();
    r.guests[0].sendPick(pick(8, 2));
    r.flush();
    expect(r.host.players[1].pick?.meter).toBe(8);
    r.guests[0].ready(pick(11, 4));
    r.flush();
    expect(r.host.players[1].pick?.meter).toBe(11);
    expect(r.host.players[1].ready).toBe(true);
    // A (hostile/duplicate) repick after ready must not unpin the choice.
    r.guests[0].sendPick(pick(5, 0));
    r.flush();
    expect(r.host.players[1].pick?.meter).toBe(11);
    // The host's roster relays the pick to every guest.
    expect(r.guests[0].players[1].pick?.meter).toBe(11);
  });

  it('drops ready frames from a stale song cycle', () => {
    const r = room(1);
    r.host.setSong(song('First'), 1);
    r.flush();
    // The guest readies against seq 1 while the host swaps to seq 2.
    const staleReady = JSON.stringify({ t: 'ready', seq: 1, pick: pick(5) });
    r.host.setSong(song('Second'), 1);
    r.host.handleGuestMessage(1, staleReady);
    expect(r.host.players[1].ready).toBe(false);
  });
});

describe('room choreography', () => {
  it('loads only when ALL present players are ready', () => {
    const r = room(2);
    let hostLoad = 0;
    r.host.onLoadRequested = () => hostLoad++;
    const guestLoads = [0, 0];
    r.guests.forEach((g, i) => (g.onLoadRequested = () => guestLoads[i]++));
    r.host.setSong(song(), 1);
    r.flush();
    r.host.ready(pick(5));
    r.guests[0].ready(pick(6));
    r.flush();
    expect(hostLoad).toBe(0); // G2 still browsing
    r.guests[1].ready(pick(7));
    r.flush();
    expect(hostLoad).toBe(1);
    expect(guestLoads).toEqual([1, 1]);
    expect(r.host.phase).toBe('loading');
    expect(r.guests.every((g) => g.phase === 'loading')).toBe(true);
  });

  it('starts everyone with per-guest half-RTT compensation', () => {
    // Host clock: pings stamped at 1000; G1 pong seen at 1040 (rtt 40),
    // G2 pong at 1010 (rtt 10). Everyone must land on one instant.
    const times = [1000, 1040, 1010];
    const r = room(2, { hostNow: () => times.shift() ?? 2000 });
    // Deliver G1's pong before G2's: stage the loaded flushes manually.
    const delays = toPlaying(r);
    expect(r.host.phase).toBe('playing');
    expect(r.guests.every((g) => g.phase === 'playing')).toBe(true);
    expect(delays.size).toBe(3);
    // Host waits GO_LEAD + maxRtt/2 = 800 + 20 = 820; the slower guest (rtt
    // 40) waits 800; the faster one (rtt 10) waits 800 + (40-10)/2 = 815.
    const sorted = [...delays.values()].sort((a, b) => a - b);
    expect(sorted[0]).toBeCloseTo(800);
    expect(Math.max(...sorted) - Math.min(...sorted)).toBeLessThanOrEqual(20);
  });

  it('relays snaps hub-and-spoke and drops stale sequence numbers', () => {
    const r = room(2);
    toPlaying(r);
    r.guests[0].sendSnap({ atSong: 1, percent: 0.5, combo: 10, life: 0.9, failed: false });
    r.guests[0].sendSnap({ atSong: 2, percent: 0.6, combo: 12, life: 0.9, failed: false });
    r.flush();
    // The host sees G1's snap, and so does G2 (relayed through the hub).
    expect(r.host.players[1].snap?.percent).toBe(0.6);
    expect(r.guests[1].players[1].snap?.percent).toBe(0.6);
    // A replayed stale frame (seq 1) must not clobber the newer one.
    r.host.handleGuestMessage(
      1,
      JSON.stringify({
        t: 'snap',
        snap: { seq: 1, atSong: 1, percent: 0.5, combo: 10, life: 0.9, failed: false },
      }),
    );
    expect(r.host.players[1].snap?.percent).toBe(0.6);
    // The host's own snaps broadcast to everyone.
    r.host.sendSnap({ atSong: 2, percent: 0.7, combo: 9, life: 1, failed: false });
    r.flush();
    expect(r.guests[0].players[0].snap?.percent).toBe(0.7);
    expect(r.guests[1].players[0].snap?.percent).toBe(0.7);
  });

  it('streams judged notes into every rival feed, playing-phase only', () => {
    const r = room(2);
    r.guests[0].sendNotes([{ i: 0, tns: 9 }]); // lobby — must not send
    r.flush();
    expect(r.host.players[1]?.notes ?? []).toHaveLength(0);
    toPlaying(r);
    r.guests[0].sendNotes([
      { i: 0, tns: 9 },
      { i: 1, tns: 4 },
    ]);
    r.host.sendNotes([{ i: 2, tns: 7 }]);
    r.flush();
    expect(r.host.players[1].notes).toEqual([
      { i: 0, tns: 9 },
      { i: 1, tns: 4 },
    ]);
    expect(r.guests[1].players[1].notes).toEqual([
      { i: 0, tns: 9 },
      { i: 1, tns: 4 },
    ]);
    expect(r.guests[0].players[0].notes).toEqual([{ i: 2, tns: 7 }]);
    // Hostile frames: bad index / non-integer tns are dropped whole.
    r.host.handleGuestMessage(1, JSON.stringify({ t: 'notes', notes: [{ i: -1, tns: 9 }] }));
    r.host.handleGuestMessage(1, JSON.stringify({ t: 'notes', notes: [{ i: 3, tns: 9.5 }] }));
    expect(r.host.players[1].notes).toHaveLength(2);
  });

  it('collects results and returns to the lobby with the room intact', () => {
    const r = room(2);
    toPlaying(r);
    r.host.finish(result(0.9));
    r.guests[0].finish(result(0.8));
    r.flush();
    expect(r.host.phase).toBe('playing'); // G2 still going
    r.guests[1].finish(result(0.7));
    r.flush();
    // Everyone is back in the lobby of the SAME room, results in hand.
    expect(r.host.phase).toBe('lobby');
    expect(r.guests.every((g) => g.phase === 'lobby')).toBe(true);
    expect(r.guests[1].players[0].result?.percent).toBe(0.9);
    expect(r.guests[1].players[1].result?.percent).toBe(0.8);
    expect(r.host.players[2].result?.percent).toBe(0.7);
    expect(r.host.ended).toBe(false);
    // The next song wipes the slate.
    r.host.setSong(song('Next'), 1);
    r.flush();
    expect(r.guests[0].players[0].result).toBeNull();
    expect(r.guests[0].players.every((p) => !p.ready && !p.done)).toBe(true);
  });

  it('a guest vanishing mid-song is a DNF, not a room end', () => {
    const r = room(2);
    toPlaying(r);
    r.guests[0].leave();
    r.flush();
    expect(r.host.phase).toBe('playing');
    expect(r.host.players.find((p) => p.id === 1)?.left).toBe(true);
    expect(r.guests[1].players.find((p) => p.id === 1)?.left).toBe(true);
    r.host.finish(result(0.9));
    r.guests[1].finish(result(0.6));
    r.flush();
    expect(r.host.phase).toBe('lobby'); // leaver no longer gates the cycle
    expect(r.host.ended).toBe(false);
  });

  it('a latecomer joining mid-song is a spectator, not a racer, and joins the next cycle', () => {
    const r = room(2);
    toPlaying(r); // HOST + G1 + G2 racing on Song
    expect(r.host.phase).toBe('playing');
    // Someone joins while the race is live.
    const late = r.addGuest('LATE');
    r.flush();
    // Admitted to the roster and handed the in-progress song (so its files can
    // transfer early)…
    expect(r.host.players.map((p) => p.name)).toContain('LATE');
    expect(late.song?.title).toBe('Song');
    expect(late.phase).toBe('playing');
    // …but the racer set was locked at load, so they cannot ready or finish this
    // cycle and never gate its end (ready is lobby-only).
    late.ready(pick(7));
    r.flush();
    expect(late.self?.ready).toBe(false);
    r.host.finish(result(0.9));
    r.guests[0].finish(result(0.8));
    r.guests[1].finish(result(0.7));
    r.flush();
    expect(r.host.phase).toBe('lobby'); // the three original racers settle it
    expect(late.phase).toBe('lobby');
    // Next cycle: the latecomer is now a full participant and DOES gate the start.
    r.host.setSong(song('Next'), 1);
    r.flush();
    r.host.ready(pick(5));
    r.guests.forEach((g, i) => g.ready(pick(6 + i)));
    r.flush();
    expect(r.host.phase).toBe('lobby'); // still waiting on LATE
    late.ready(pick(9));
    r.flush();
    expect(r.host.phase).toBe('loading'); // everyone, latecomer included
  });

  it('a guest vanishing in the lobby just leaves the roster', () => {
    const r = room(2);
    r.guests[0].leave();
    r.flush();
    expect(r.host.players.map((p) => p.name)).toEqual(['HOST', 'G2']);
    expect(r.guests[1].players.map((p) => p.name)).toEqual(['HOST', 'G2']);
    expect(r.host.ended).toBe(false);
  });

  it('a mid-song spectator cannot inject snaps or notes into the race', () => {
    const r = room(2);
    toPlaying(r);
    const late = r.addGuest('LATE');
    r.flush();
    const lateId = r.host.players.find((p) => p.name === 'LATE')!.id;
    // The spectator's phase is 'playing' (via roster), so its send guards pass —
    // but it was never enrolled as a racer, so the host must not store or relay.
    late.sendSnap({ atSong: 1, percent: 0.99, combo: 50, life: 1, failed: false });
    late.sendNotes([{ i: 0, tns: 9 }]);
    r.flush();
    expect(r.host.players.find((p) => p.id === lateId)?.snap ?? null).toBeNull();
    expect(r.host.players.find((p) => p.id === lateId)?.notes).toEqual([]);
    // And nothing was amplified to the other racers.
    expect(r.guests[0].players.find((p) => p.id === lateId)?.snap ?? null).toBeNull();
  });

  it('a mid-loading leaver does not wedge the start gate', () => {
    const r = room(2);
    r.host.setSong(song(), 1);
    r.flush();
    r.host.ready(pick(5));
    r.guests.forEach((g, i) => g.ready(pick(6 + i)));
    r.flush();
    expect(r.host.phase).toBe('loading');
    r.host.loaded();
    r.guests[1].loaded();
    r.flush();
    expect(r.host.phase).toBe('loading'); // waiting on G1
    r.guests[0].leave(); // …who bails instead
    r.flush();
    expect(r.host.phase).toBe('playing');
    expect(r.guests[1].phase).toBe('playing');
  });

  it('the host leaving ends the room for everyone', () => {
    const r = room(2);
    const reasons: string[] = [];
    r.guests.forEach((g) => (g.onClosed = (why) => reasons.push(why)));
    r.host.leave();
    r.flush();
    expect(r.host.ended).toBe(true);
    expect(r.guests.every((g) => g.ended)).toBe(true);
    expect(reasons).toEqual(['host-left', 'host-left']);
  });

  it('setSong is lobby-only — a pick mid-race waits for the cycle to end', () => {
    const r = room(1);
    toPlaying(r);
    r.host.setSong(song('Too Early'), 1);
    r.flush();
    expect(r.host.song?.title).toBe('Song'); // ignored while playing
    r.host.finish(result(0.9));
    r.guests[0].finish(result(0.8));
    r.flush();
    expect(r.host.phase).toBe('lobby'); // …the store replays the want here
    r.host.setSong(song('Next'), 1);
    r.flush();
    expect(r.host.song?.title).toBe('Next');
    expect(r.guests[0].song?.title).toBe('Next');
  });

  it('the host can force-start with whoever is ready, leaving the rest to spectate', () => {
    const r = room(2);
    r.host.setSong(song(), 1);
    r.flush();
    r.host.ready(pick(5));
    r.guests[0].ready(pick(6)); // G1 readies; G2 is stuck/AFK and never does
    r.flush();
    expect(r.host.phase).toBe('lobby'); // normally blocked on G2
    r.host.forceStart();
    r.flush();
    expect(r.host.phase).toBe('loading'); // began with host + G1 only
    r.host.loaded();
    r.guests[0].loaded();
    r.flush();
    expect(r.host.phase).toBe('playing');
    expect(r.guests[0].phase).toBe('playing');
    expect(r.guests[1].self?.ready).toBe(false); // G2 never joined the race
    // The two racers settle the cycle — G2 was never a racer, never gated it.
    r.host.finish(result(0.9));
    r.guests[0].finish(result(0.8));
    r.flush();
    expect(r.host.phase).toBe('lobby');
  });

  it('force-start needs at least two ready — a lone ready host is a no-op', () => {
    const r = room(1);
    r.host.setSong(song(), 1);
    r.flush();
    r.host.ready(pick(5)); // only the host is ready
    r.flush();
    r.host.forceStart();
    r.flush();
    expect(r.host.phase).toBe('lobby');
  });

  it('a force-start that races a guest ready leaves that guest out, not wedged', () => {
    const r = room(2);
    r.host.setSong(song(), 1);
    r.flush();
    r.host.ready(pick(5));
    r.guests[0].ready(pick(6)); // G1 ready
    r.flush();
    // G2 readies, but its frame is still in flight when the host force-starts.
    let g2Loaded = false;
    r.guests[1].onLoadRequested = () => {
      g2Loaded = true;
    };
    r.guests[1].ready(pick(7)); // queued, NOT flushed
    expect(r.host.players.find((p) => p.id === 2)?.ready).toBe(false); // host hasn't seen it
    r.host.forceStart(); // racers = {host, G1}; G2's ready arrives after
    r.flush();
    expect(r.host.phase).toBe('loading');
    // G2 got the load frame but self-excluded — it isn't in the racer list.
    expect(g2Loaded).toBe(false);
    // The race runs and ends on host + G1 only; G2 never gated it.
    r.host.loaded();
    r.guests[0].loaded();
    r.flush();
    r.host.finish(result(0.9));
    r.guests[0].finish(result(0.8));
    r.flush();
    expect(r.host.phase).toBe('lobby');
  });

  it('force-start is a no-op until the host itself is ready', () => {
    const r = room(2);
    r.host.setSong(song(), 1);
    r.flush();
    r.guests[0].ready(pick(6));
    r.guests[1].ready(pick(7)); // both guests ready, host has not
    r.flush();
    r.host.forceStart();
    r.flush();
    expect(r.host.phase).toBe('lobby'); // the host must ready first
  });

  it('a lone host cannot start a song', () => {
    const r = room(1);
    r.host.setSong(song(), 1);
    r.flush();
    r.host.ready(pick(5));
    r.guests[0].leave();
    r.flush();
    expect(r.host.phase).toBe('lobby');
    expect(r.host.self?.ready).toBe(false); // pinned ready released
  });
});

describe('song transfer routing', () => {
  it('routes fileReq to the host with the asking guest id', () => {
    const r = room(2);
    const asks: number[] = [];
    r.host.onFileReq = (id) => asks.push(id);
    r.guests[1].requestFile();
    r.flush();
    expect(asks).toEqual([2]);
    const metas: object[] = [];
    let done = 0;
    r.guests[1].onFileMeta = (m) => metas.push(m);
    r.guests[1].onFileDone = () => done++;
    r.host.sendFileMeta(2, {
      simfileName: 'song.ssc',
      simfile: '#TITLE:x;',
      files: [
        { name: 'song.ogg', kind: 'audio', bytes: 1234 },
        { name: 'bg.png', kind: 'bg', bytes: 99 },
      ],
    });
    r.host.sendFileDone(2);
    r.flush();
    expect(metas).toHaveLength(1);
    expect(done).toBe(1);
    // The other guest heard nothing.
    let otherMeta = 0;
    r.guests[0].onFileMeta = () => otherMeta++;
    r.flush();
    expect(otherMeta).toBe(0);
  });
});

describe('hostile input', () => {
  it('ignores garbage and unknown frames on both ends', () => {
    const r = room(1);
    r.host.handleGuestMessage(1, 'not json');
    r.host.handleGuestMessage(1, JSON.stringify({ t: 'exploit' }));
    r.guests[0].handleMessage('not json');
    r.guests[0].handleMessage(JSON.stringify({ t: 'go', delayMs: -5 }));
    expect(r.host.phase).toBe('lobby');
    expect(r.guests[0].phase).toBe('lobby');
  });

  it('rejects malformed frames in the parsers', () => {
    expect(parseGuestMsg(JSON.stringify({ t: 'ready', seq: 0 }))).toBeNull(); // pick mandatory
    expect(parseGuestMsg(JSON.stringify({ t: 'ready', pick: pick(5) }))).toBeNull(); // seq mandatory
    expect(parseHostMsg(JSON.stringify({ t: 'go', delayMs: 999_999 }))).toBeNull();
    expect(parseHostMsg(JSON.stringify({ t: 'roster', phase: 'nope', players: [] }))).toBeNull();
    expect(
      parseHostMsg(
        JSON.stringify({
          t: 'fileMeta',
          simfileName: 'a.ssc',
          simfile: 'x',
          files: [{ name: 'x.ogg', kind: 'audio', bytes: 65 * 1024 * 1024 }], // over cap
        }),
      ),
    ).toBeNull();
    // Nothing before hello counts.
    const host = new RoomHost(CODE, { name: 'H' });
    const id = host.attachGuest({ send: () => {}, close: () => {} });
    host.handleGuestMessage(id, JSON.stringify({ t: 'ready', seq: 0, pick: pick(5) }));
    expect(host.players).toHaveLength(1);
  });
});
