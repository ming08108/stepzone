/**
 * Replays: the pad-name heuristic (padDetect), the local best-replay store
 * (app/replays — sanitize + least-recently-written eviction), and the engine
 * guarantee everything rests on: feeding a recorded (t, track, up) log through
 * Judge.step reproduces the exact same judgments (deterministic replay). The
 * store part stubs localStorage; no browser, no DOM.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DANCE_PAD_ID_MARKERS, looksLikeDancePad } from '../src/input/padDetect';
import { saveReplay, loadReplay } from '../src/app/replays';
import { Judge } from '../src/gameplay/judge';
import { NoteData } from '../src/notes/noteData';
import { TimingData } from '../src/timing/timingData';
import {
  beatToNoteRow,
  NO_KEYSOUND,
  NO_PLAYER,
  TapNoteSubType,
  TapNoteType,
  type TapNote,
} from '../src/notes/noteTypes';
import type { ReplayEvent } from '../src/net/protocol';

describe('looksLikeDancePad', () => {
  it('matches known dance-pad names case-insensitively', () => {
    for (const id of [
      'L-Tek USB Pad',
      'StepManiaX Dedicated Cabinet',
      'RE:Flex Dance Pad',
      'Cobalt Flux',
      'Generic DANCE PAD',
      'FSR Mini Pad',
      'DDR Controller',
      'PIUIO interface',
    ]) {
      expect(looksLikeDancePad(id)).toBe(true);
    }
  });

  it('does not match ordinary controllers', () => {
    for (const id of ['Xbox 360 Controller', 'DualSense Wireless', 'Generic USB Joystick', '']) {
      expect(looksLikeDancePad(id)).toBe(false);
    }
  });

  it('every documented marker actually matches', () => {
    for (const marker of DANCE_PAD_ID_MARKERS) {
      expect(looksLikeDancePad(`prefix ${marker.toUpperCase()} suffix`)).toBe(true);
    }
  });
});

describe('app/replays local store', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, String(v)),
        removeItem: (k: string) => void store.delete(k),
      },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    vi.restoreAllMocks();
  });

  const log: ReplayEvent[] = [
    { t: 0, track: 0, up: false },
    { t: 0.1, track: 0, up: true },
  ];

  it('round-trips a saved replay by chart + rate', () => {
    saveReplay('hashA', 100, log);
    expect(loadReplay('hashA', 100)).toEqual(log);
    // Different rate is a different slot.
    expect(loadReplay('hashA', 150)).toBeNull();
  });

  it('drops an over-long log rather than storing it', () => {
    const huge = Array.from({ length: 30_001 }, (_, i) => ({ t: i, track: 0, up: false }));
    saveReplay('hashB', 100, huge);
    expect(loadReplay('hashB', 100)).toBeNull();
  });

  it('evicts the least-recently-written when full', () => {
    let t = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => t++);
    for (let i = 0; i < 41; i++) saveReplay(`chart${i}`, 100, log);
    // The very first (oldest write) fell off; the newest survives.
    expect(loadReplay('chart0', 100)).toBeNull();
    expect(loadReplay('chart40', 100)).toEqual(log);
  });

  it('survives corrupt storage', () => {
    store.set('notefield.replays.v1', '{not json');
    expect(loadReplay('hashA', 100)).toBeNull();
  });
});

// ---- Deterministic replay: recorded events reproduce the same judgments -----

function tap(): TapNote {
  return {
    type: TapNoteType.Tap,
    subType: TapNoteSubType.Invalid,
    durationRows: 0,
    keysoundIndex: NO_KEYSOUND,
    player: NO_PLAYER,
  };
}

/** A tiny 4-panel chart at 60 BPM (beat N == N seconds), including a jump. */
function chartJudge(): Judge {
  const nd = new NoteData(4);
  const taps: Array<[number, number]> = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 0],
    [4, 1], // a jump on beat 4
  ];
  for (const [beat, track] of taps) nd.setTapNote(track, beatToNoteRow(beat), tap());
  const timing = new TimingData();
  timing.bpms.push({ row: 0, bps: 1 });
  timing.tidy();
  return new Judge(nd, timing);
}

/** Drive a fresh judge with a recorded log the way the session loop does. */
function simulate(events: ReplayEvent[]): Record<number, number> {
  const judge = chartJudge();
  const held = [false, false, false, false];
  let ei = 0;
  for (let t = 0; t <= 6; t += 1 / 60) {
    while (ei < events.length && events[ei].t <= t) {
      const e = events[ei++];
      judge.step(e.track, e.t, e.up);
      held[e.track] = !e.up;
    }
    judge.update(t, held);
  }
  return { ...judge.tapCounts };
}

describe('replay determinism', () => {
  // A perfect run: press exactly on every note time (the jump is two presses).
  const log: ReplayEvent[] = [
    { t: 0, track: 0, up: false },
    { t: 1, track: 1, up: false },
    { t: 2, track: 2, up: false },
    { t: 3, track: 3, up: false },
    { t: 4, track: 0, up: false },
    { t: 4, track: 1, up: false },
  ];

  it('reproduces identical tapCounts when the log is replayed', () => {
    const first = simulate(log);
    const second = simulate(log);
    expect(second).toEqual(first);
    // Sanity: all six notes were hit (no misses).
    const hits = Object.entries(first)
      .filter(([k]) => Number(k) >= 5) // W5..W1
      .reduce((a, [, n]) => a + n, 0);
    expect(hits).toBe(6);
  });
});
