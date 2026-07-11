/**
 * The P2P versus flow, host and joiner driven over an in-memory wire: the
 * exact message choreography (hello -> ready -> load -> loaded -> ping/pong ->
 * go -> snaps -> finish) that runs on the RTCDataChannel in the app.
 */
import { describe, expect, it } from 'vitest';
import type { PlayResult } from '../src/net/protocol';
import { codeToArrows, isRoomCode, parsePeerMsg, randomRoomCode } from '../src/net/versus';
import { VersusMatch, type PeerChannel } from '../src/net/versusMatch';

/** Two buffering channels that deliver to the opposite match once attached. */
function wire(opts?: { hostNow?: () => number }) {
  const queues: [string[], string[]] = [[], []];
  const matches: (VersusMatch | undefined)[] = [undefined, undefined];
  const closed = [false, false];
  const flush = () => {
    for (let side = 0; side < 2; side++) {
      const target = matches[1 - side];
      if (!target) continue;
      while (queues[side].length > 0) target.handleMessage(queues[side].shift()!);
    }
  };
  const chan = (side: 0 | 1): PeerChannel => ({
    send: (d) => {
      if (closed[side]) throw new Error('closed');
      queues[side].push(d);
      flush();
    },
    close: () => {
      closed[side] = true;
      matches[1 - side]?.handleClose();
    },
  });
  const host = new VersusMatch(chan(0), { isHost: true, name: 'HOST', now: opts?.hostNow });
  const joiner = new VersusMatch(chan(1), { isHost: false, name: 'JOINER' });
  matches[0] = host;
  matches[1] = joiner;
  flush();
  return { host, joiner };
}

const result = (percent: number): PlayResult => ({
  percent,
  grade: 'A',
  maxCombo: 10,
  failed: false,
  counts: { 9: 10 },
  holdCounts: {},
});

/** Drive a pair through ready -> loading -> loaded -> playing. */
function toPlaying(pair: ReturnType<typeof wire>) {
  const goDelays: number[] = [];
  pair.host.onGo = (d) => goDelays.push(d);
  pair.joiner.onGo = (d) => goDelays.push(d);
  pair.host.ready();
  pair.joiner.ready();
  pair.host.loaded();
  pair.joiner.loaded();
  return goDelays;
}

describe('room codes', () => {
  it('generates valid 6-arrow codes and renders them as glyphs', () => {
    const code = randomRoomCode();
    expect(isRoomCode(code)).toBe(true);
    expect(codeToArrows('LDUR' + code.slice(4)).startsWith('← ↓ ↑ →')).toBe(true);
    expect(isRoomCode('LDURL')).toBe(false); // too short
    expect(isRoomCode('LDURLX')).toBe(false); // bad symbol
  });
});

describe('VersusMatch flow', () => {
  it('exchanges hellos into the lobby', () => {
    const { host, joiner } = wire();
    expect(host.phase).toBe('lobby');
    expect(joiner.phase).toBe('lobby');
    expect(host.opponent.name).toBe('JOINER');
    expect(joiner.opponent.name).toBe('HOST');
  });

  it('host requests load only when both are ready', () => {
    const { host, joiner } = wire();
    let hostLoad = 0;
    let joinerLoad = 0;
    host.onLoadRequested = () => hostLoad++;
    joiner.onLoadRequested = () => joinerLoad++;
    host.ready();
    expect(hostLoad + joinerLoad).toBe(0); // waiting on the joiner
    joiner.ready();
    expect(hostLoad).toBe(1);
    expect(joinerLoad).toBe(1);
    expect(host.phase).toBe('loading');
    expect(joiner.phase).toBe('loading');
  });

  it('starts both sides with half-RTT compensation after both load', () => {
    // Host clock: ping stamped at 1000, pong observed at 1040 -> rtt 40.
    const times = [1000, 1040];
    const { host, joiner } = wire({ hostNow: () => times.shift() ?? 2000 });
    const delays = toPlaying({ host, joiner });
    expect(host.phase).toBe('playing');
    expect(joiner.phase).toBe('playing');
    expect(host.rttMs).toBe(40);
    // Joiner waits the base lead; host waits base + rtt/2.
    expect(Math.max(...delays) - Math.min(...delays)).toBeCloseTo(20);
  });

  it('relays snaps and drops stale sequence numbers', () => {
    const pair = wire();
    toPlaying(pair);
    pair.host.sendSnap({ atSong: 1, percent: 0.5, combo: 10, life: 0.9, failed: false });
    pair.host.sendSnap({ atSong: 2, percent: 0.6, combo: 12, life: 0.9, failed: false });
    expect(pair.joiner.opponent.snap?.percent).toBe(0.6);
    // A replayed stale frame (seq 1) must not clobber the newer one.
    pair.joiner.handleMessage(
      JSON.stringify({
        t: 'snap',
        snap: { seq: 1, atSong: 1, percent: 0.5, combo: 10, life: 0.9, failed: false },
      }),
    );
    expect(pair.joiner.opponent.snap?.percent).toBe(0.6);
  });

  it('finishes into done once both results are in', () => {
    const pair = wire();
    toPlaying(pair);
    pair.host.finish(result(0.9));
    expect(pair.host.phase).toBe('playing'); // opponent still going
    pair.joiner.finish(result(0.8));
    expect(pair.host.phase).toBe('done');
    expect(pair.joiner.phase).toBe('done');
    expect(pair.host.results.opponent?.percent).toBe(0.8);
    expect(pair.joiner.results.opponent?.percent).toBe(0.9);
  });

  it('a peer vanishing in the lobby ends the room', () => {
    const { host, joiner } = wire();
    joiner.leave();
    expect(host.phase).toBe('done');
    expect(host.opponent.left).toBe(true);
  });

  it('a peer vanishing mid-match leaves the local player playing', () => {
    const pair = wire();
    toPlaying(pair);
    pair.joiner.leave();
    expect(pair.host.phase).toBe('playing'); // keep playing to the end
    expect(pair.host.opponent.left).toBe(true);
    pair.host.finish(result(0.9));
    expect(pair.host.phase).toBe('done');
  });

  it('ignores garbage and unknown frames from the peer', () => {
    const { host } = wire();
    host.handleMessage('not json');
    host.handleMessage(JSON.stringify({ t: 'exploit', x: 1 }));
    host.handleMessage(JSON.stringify({ t: 'go', delayMs: -5 }));
    expect(host.phase).toBe('lobby');
    expect(parsePeerMsg(JSON.stringify({ t: 'go', delayMs: 999999 }))).toBeNull();
  });
});
