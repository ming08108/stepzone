import { describe, expect, it } from 'vitest';
import type { ActiveNote } from '../src/gameplay/judge';
import {
  HoldNoteScore,
  TapNoteScore,
  TapNoteSubType,
  TapNoteType,
  beatToNoteRow,
} from '../src/notes/noteTypes';
import {
  DRAW_CULL,
  FALLBACK_MAX_BPM,
  SPACING,
  advanceCursor,
  appearanceAlpha,
  holdHeadState,
  holdIsAlive,
  holdIsHeld,
  noteEndY,
  notYet,
  passed,
  shouldDrawHoldBody,
  shouldDrawNote,
  songMaxBpm,
  yOf,
  type ScrollState,
} from '../src/render/scroll';

function state(over: Partial<ScrollState> = {}): ScrollState {
  return {
    mode: 'C',
    value: 600, // C600 => 640 px/sec at SPACING 64
    songMaxBpm: 200,
    reverse: false,
    appearance: 'visible',
    receptorY: 100,
    height: 800,
    nowSeconds: 10,
    nowBeat: 20,
    ...over,
  };
}

function note(over: Partial<ActiveNote> = {}): ActiveNote {
  const time = over.time ?? 0;
  const row = over.row ?? 0;
  const type = over.note?.type ?? TapNoteType.Tap;
  return {
    track: 0,
    row,
    beat: row / 48,
    time,
    note: {
      type,
      subType: type === TapNoteType.HoldHead ? TapNoteSubType.Hold : TapNoteSubType.Invalid,
      durationRows: 0,
      keysoundIndex: -1,
      player: -1,
    },
    judgable: true,
    tns: TapNoteScore.None,
    offset: 0,
    hidden: false,
    isHold: type === TapNoteType.HoldHead,
    isRoll: false,
    tailRow: row,
    tailTime: time,
    holdInitiated: false,
    holdLife: 1,
    hns: HoldNoteScore.None,
    holdResolved: false,
    ...over,
  };
}

describe('yOf', () => {
  it('C mode: value/60 * SPACING px per second, receptor at now', () => {
    const s = state({ mode: 'C', value: 600 });
    expect(yOf(s, s.nowSeconds, 0)).toBe(100); // at the receptor
    // 1 second later: 600/60 * 64 = 640 px further down the approach side.
    expect(yOf(s, s.nowSeconds + 1, 0)).toBe(100 + 640);
    expect(yOf(s, s.nowSeconds - 0.5, 0)).toBe(100 - 320);
  });

  it('C mode ignores beats; X/M modes ignore time', () => {
    const s = state({ mode: 'C' });
    expect(yOf(s, s.nowSeconds, 999)).toBe(100);
    const x = state({ mode: 'X', value: 2 });
    expect(yOf(x, 999, x.nowBeat)).toBe(100);
  });

  it('X mode: SPACING * multiplier px per beat', () => {
    const s = state({ mode: 'X', value: 2 });
    expect(yOf(s, 0, s.nowBeat + 1)).toBe(100 + 128);
    expect(yOf(s, 0, s.nowBeat - 2)).toBe(100 - 256);
  });

  it('M mode: X scaled so the peak BPM hits the target rate', () => {
    // Target 600 on a 300-peak song = effective 2x.
    const s = state({ mode: 'M', value: 600, songMaxBpm: 300 });
    expect(yOf(s, 0, s.nowBeat + 1)).toBe(100 + 128);
  });

  it('reverse flips the scroll direction around the receptor', () => {
    const s = state({ mode: 'C', value: 600, reverse: true, receptorY: 700 });
    expect(yOf(s, s.nowSeconds, 0)).toBe(700);
    expect(yOf(s, s.nowSeconds + 1, 0)).toBe(700 - 640); // approaches from above
  });
});

describe('appearanceAlpha', () => {
  it('visible: always 1', () => {
    const s = state({ appearance: 'visible' });
    expect(appearanceAlpha(s, s.receptorY)).toBe(1);
    expect(appearanceAlpha(s, s.receptorY + 5000)).toBe(1);
  });

  it('hidden: 0 at the receptor, fading in by 40% of the height away', () => {
    const s = state({ appearance: 'hidden', receptorY: 100, height: 800 });
    expect(appearanceAlpha(s, 100)).toBe(0);
    expect(appearanceAlpha(s, 100 + 0.12 * 800)).toBe(0); // fade-in start
    expect(appearanceAlpha(s, 100 + 0.26 * 800)).toBeCloseTo(0.5, 5); // midpoint
    expect(appearanceAlpha(s, 100 + 0.4 * 800)).toBe(1); // fully visible
    expect(appearanceAlpha(s, 100 - 0.4 * 800)).toBe(1); // symmetric above
  });

  it('sudden: 1 near the receptor, gone past 78% of the height away', () => {
    const s = state({ appearance: 'sudden', receptorY: 100, height: 800 });
    expect(appearanceAlpha(s, 100)).toBe(1);
    expect(appearanceAlpha(s, 100 + 0.5 * 800)).toBe(1); // fade-out start
    expect(appearanceAlpha(s, 100 + 0.64 * 800)).toBeCloseTo(0.5, 5);
    expect(appearanceAlpha(s, 100 + 0.78 * 800)).toBe(0);
  });
});

describe('passed / notYet culling', () => {
  it('upscroll: passed above the top, notYet below the bottom', () => {
    const s = state();
    expect(passed(s, -DRAW_CULL - 1)).toBe(true);
    expect(passed(s, -DRAW_CULL)).toBe(false); // boundary is inclusive-visible
    expect(notYet(s, s.height + DRAW_CULL + 1)).toBe(true);
    expect(notYet(s, s.height + DRAW_CULL)).toBe(false);
    expect(passed(s, 400) || notYet(s, 400)).toBe(false);
  });

  it('reverse swaps the exit and entry sides', () => {
    const s = state({ reverse: true });
    expect(passed(s, s.height + DRAW_CULL + 1)).toBe(true);
    expect(passed(s, -DRAW_CULL - 1)).toBe(false);
    expect(notYet(s, -DRAW_CULL - 1)).toBe(true);
    expect(notYet(s, s.height + DRAW_CULL + 1)).toBe(false);
  });
});

describe('noteEndY / advanceCursor', () => {
  it('a hold lives until its tail passes, not its head', () => {
    const s = state({ mode: 'C', value: 600, nowSeconds: 10 });
    const tap = note({ time: 8 });
    const hold = note({
      time: 8,
      note: {
        type: TapNoteType.HoldHead,
        subType: TapNoteSubType.Hold,
        durationRows: 96,
        keysoundIndex: -1,
        player: -1,
      },
      tailRow: beatToNoteRow(2),
      tailTime: 10.1,
    });
    // Head at 8s is 2s past the receptor (1280px above) — long gone...
    expect(passed(s, noteEndY(s, tap))).toBe(true);
    // ...but the hold tail (10.1s) is still below the receptor.
    expect(passed(s, noteEndY(s, hold))).toBe(false);
  });

  it('advances past exited notes and stops at the first visible one', () => {
    const s = state({ mode: 'C', value: 600, nowSeconds: 10, receptorY: 100 });
    // 640 px/s: a note exits (y < -100) once it is > ~0.31s past the receptor.
    const notes = [note({ time: 8 }), note({ time: 9 }), note({ time: 9.9 }), note({ time: 11 })];
    expect(advanceCursor(s, notes, 0)).toBe(2);
    // Forward-only: never rewinds even if handed a later start.
    expect(advanceCursor(s, notes, 3)).toBe(3);
  });

  it('returns notes.length when everything has exited', () => {
    const s = state({ mode: 'C', value: 600, nowSeconds: 100 });
    const notes = [note({ time: 1 }), note({ time: 2 })];
    expect(advanceCursor(s, notes, 0)).toBe(2);
  });

  it('an engaged hold pins the window open until the tail exits', () => {
    const s = state({ mode: 'C', value: 600, nowSeconds: 10 });
    const notes = [
      note({
        time: 5,
        note: {
          type: TapNoteType.HoldHead,
          subType: TapNoteSubType.Hold,
          durationRows: 480,
          keysoundIndex: -1,
          player: -1,
        },
        tailRow: beatToNoteRow(10),
        tailTime: 12,
      }),
      note({ time: 10.2 }),
    ];
    expect(advanceCursor(s, notes, 0)).toBe(0);
  });
});

describe('note-state view (renderer side of finding #22)', () => {
  it('draws plain taps unless judged-hidden or autokeysound', () => {
    expect(shouldDrawNote(note())).toBe(true);
    expect(shouldDrawNote(note({ hidden: true }))).toBe(false);
    expect(
      shouldDrawNote(
        note({
          note: {
            type: TapNoteType.AutoKeysound,
            subType: TapNoteSubType.Invalid,
            durationRows: 0,
            keysoundIndex: 0,
            player: -1,
          },
        }),
      ),
    ).toBe(false);
  });

  it('hold heads are excluded from the plain-note pass (they have a lifecycle)', () => {
    const hold = () =>
      note({
        note: {
          type: TapNoteType.HoldHead,
          subType: TapNoteSubType.Hold,
          durationRows: 48,
          keysoundIndex: -1,
          player: -1,
        },
      });
    expect(shouldDrawNote(hold())).toBe(false);
    expect(shouldDrawNote(note())).toBe(true);
    // holdHeadState drives the head instead (DDR lifecycle).
    expect(holdHeadState(hold(), 0)).toBe('approach');
    const hit = { ...hold(), time: 5, tns: TapNoteScore.W1, holdInitiated: true };
    expect(holdHeadState(hit, 4.9)).toBe('approach'); // early hit: still scrolls in
    expect(holdHeadState(hit, 5.1)).toBe('engaged'); // pinned on the receptor
    expect(holdHeadState({ ...hit, holdResolved: true, hns: HoldNoteScore.LetGo }, 6)).toBe(
      'dropped',
    );
    expect(holdHeadState({ ...hold(), holdResolved: true, hns: HoldNoteScore.Missed }, 6)).toBe(
      'dropped',
    );
    expect(holdHeadState({ ...hit, holdResolved: true, hns: HoldNoteScore.Held }, 6)).toBe('gone');
  });

  it('hold bodies draw until Held; dropped/missed holds stay visible to scroll off grey', () => {
    const hold = (over: Partial<ActiveNote> = {}) =>
      note({
        note: {
          type: TapNoteType.HoldHead,
          subType: TapNoteSubType.Hold,
          durationRows: 48,
          keysoundIndex: -1,
          player: -1,
        },
        ...over,
      });
    expect(shouldDrawHoldBody(hold({ tns: TapNoteScore.W1 }))).toBe(true);
    expect(shouldDrawHoldBody(hold({ holdResolved: true, hns: HoldNoteScore.LetGo }))).toBe(true);
    expect(shouldDrawHoldBody(hold({ holdResolved: true, hns: HoldNoteScore.Missed }))).toBe(true);
    expect(shouldDrawHoldBody(hold({ holdResolved: true, hns: HoldNoteScore.Held }))).toBe(false);
    expect(shouldDrawHoldBody(note())).toBe(false);
  });

  it('hold held/alive state', () => {
    const h = note({ time: 5, holdInitiated: true, holdLife: 0.5 });
    expect(holdIsHeld(h, 4.9)).toBe(false); // head not reached yet
    expect(holdIsHeld(h, 5.1)).toBe(true);
    expect(holdIsHeld({ ...h, holdInitiated: false }, 5.1)).toBe(false);
    // A scored hold no longer pins to the receptor — it scrolls off.
    expect(holdIsHeld({ ...h, holdResolved: true, hns: HoldNoteScore.LetGo }, 5.1)).toBe(false);
    expect(holdIsAlive(h)).toBe(true);
    expect(holdIsAlive({ ...h, holdLife: 0 })).toBe(false);
    expect(holdIsAlive({ ...h, holdInitiated: false, holdLife: 0 })).toBe(true);
    // Missed holds resolve without initiation — dead (grey), not alive.
    expect(
      holdIsAlive({ ...h, holdInitiated: false, holdResolved: true, hns: HoldNoteScore.Missed }),
    ).toBe(false);
  });
});

describe('songMaxBpm', () => {
  it('takes the peak of the bpm segments', () => {
    expect(songMaxBpm([{ bps: 2 }, { bps: 5 }, { bps: 3 }])).toBe(300);
  });
  it('falls back to the shared constant when empty or non-positive', () => {
    expect(songMaxBpm([])).toBe(FALLBACK_MAX_BPM);
    expect(songMaxBpm([{ bps: 0 }])).toBe(FALLBACK_MAX_BPM);
  });
  it('SPACING stays the ITG arrow spacing the math is calibrated to', () => {
    expect(SPACING).toBe(64);
  });
});
