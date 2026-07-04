/**
 * The gameplay runtime: turns input events + the passage of time into
 * judgments, combo, dance-point %, and life. Pure (no audio/DOM) so it is
 * unit-tested; the game loop drives it with `step()` and `update()`.
 *
 * Faithful to spec doc 4 for the single-player dance case. Simplifications noted
 * in scoring.ts (per-note combo, raw life deltas). Warp/fake notes are never
 * judged or missed.
 */

import {
  HoldNoteScore,
  TapNoteScore,
  TapNoteSubType,
  TapNoteType,
  type TapNote,
  noteRowToBeat,
} from '../notes/noteTypes';
import { NoteData } from '../notes/noteData';
import { TimingData } from '../timing/timingData';
import {
  holdDancePoints,
  holdGradePoints,
  holdLifeDelta,
  tapDancePoints,
  tapGradePoints,
  tapLifeDelta,
  gradeFromPercent,
} from './scoring';
import { DEFAULT_WINDOWS, maxWindowSeconds, windowSeconds, type TimingWindows } from './windows';

export interface ActiveNote {
  track: number;
  row: number;
  beat: number;
  /** Head time in seconds. */
  time: number;
  note: TapNote;
  judgable: boolean;

  // Tap result.
  tns: TapNoteScore;
  offset: number; // seconds; negative = early
  hidden: boolean;

  // Hold/roll state (HoldHead only).
  isHold: boolean;
  isRoll: boolean;
  tailRow: number;
  tailTime: number;
  holdInitiated: boolean;
  holdLife: number;
  hns: HoldNoteScore;
  holdResolved: boolean;
}

export interface JudgeEvent {
  track: number;
  tns: TapNoteScore;
  offset: number;
  combo: number;
}

const INITIAL_LIFE = 0.5;

export class Judge {
  readonly windows: TimingWindows;
  readonly notesByTrack: ActiveNote[][];
  readonly notes: ActiveNote[]; // flat, sorted by time

  combo = 0;
  maxCombo = 0;
  missCombo = 0;
  life = INITIAL_LIFE;
  failed = false;

  /** Increments on every tap judgment (hit, miss, or mine) for UI feedback. */
  judgmentSeq = 0;
  lastTns: TapNoteScore = TapNoteScore.None;

  readonly tapCounts: Record<number, number> = {};
  readonly holdCounts: Record<number, number> = {};

  private actualDance = 0;
  private possibleDance = 0;
  private possibleGrade = 0;
  private readonly rate: number;
  private readonly maxWindow: number;
  private lastUpdate = 0;

  constructor(
    noteData: NoteData,
    timing: TimingData,
    windows: TimingWindows = DEFAULT_WINDOWS,
    rate = 1,
  ) {
    this.windows = windows;
    this.rate = rate;
    // Windows are in chart-seconds; at rate r a real ±W is ±(W·r) chart-seconds.
    this.maxWindow = maxWindowSeconds(windows) * rate;
    this.notesByTrack = Array.from({ length: noteData.numTracks }, () => []);
    this.notes = [];

    for (let track = 0; track < noteData.numTracks; track++) {
      for (const { row, note } of noteData.getTrack(track)) {
        if (note.type === TapNoteType.Empty) continue;
        const beat = noteRowToBeat(row);
        const scoreableType =
          note.type === TapNoteType.Tap ||
          note.type === TapNoteType.HoldHead ||
          note.type === TapNoteType.Mine ||
          note.type === TapNoteType.Lift;
        const judgable = scoreableType && timing.isJudgableAtRow(row);
        const isHoldHead = note.type === TapNoteType.HoldHead;
        const tailRow = isHoldHead ? row + note.durationRows : row;

        const an: ActiveNote = {
          track,
          row,
          beat,
          time: timing.getElapsedTimeFromBeat(beat),
          note,
          judgable,
          tns: TapNoteScore.None,
          offset: 0,
          hidden: false,
          isHold: isHoldHead && note.subType === TapNoteSubType.Hold,
          isRoll: isHoldHead && note.subType === TapNoteSubType.Roll,
          tailRow,
          tailTime: timing.getElapsedTimeFromBeat(noteRowToBeat(tailRow)),
          holdInitiated: false,
          holdLife: 1,
          hns: HoldNoteScore.None,
          holdResolved: false,
        };
        this.notesByTrack[track].push(an);
        this.notes.push(an);

        // Precompute the maximum achievable points.
        if (judgable) {
          if (note.type !== TapNoteType.Mine) {
            this.possibleDance += tapDancePoints(TapNoteScore.W1);
            this.possibleGrade += tapGradePoints(TapNoteScore.W1);
          }
          if (isHoldHead) {
            this.possibleDance += holdDancePoints(HoldNoteScore.Held);
            this.possibleGrade += holdGradePoints(HoldNoteScore.Held);
          }
        }
      }
    }
    this.notes.sort((a, b) => a.time - b.time || a.track - b.track);
  }

  /** Effective (rate-scaled) window in chart-seconds. */
  private win(key: 'w1' | 'w2' | 'w3' | 'w4' | 'w5' | 'mine' | 'hold' | 'roll'): number {
    return windowSeconds(this.windows, key) * this.rate;
  }

  private classify(err: number): TapNoteScore {
    if (err <= this.win('w1')) return TapNoteScore.W1;
    if (err <= this.win('w2')) return TapNoteScore.W2;
    if (err <= this.win('w3')) return TapNoteScore.W3;
    if (err <= this.win('w4')) return TapNoteScore.W4;
    if (err <= this.win('w5')) return TapNoteScore.W5;
    return TapNoteScore.None;
  }

  private changeLife(delta: number): void {
    if (this.failed) return;
    this.life = Math.min(1, Math.max(0, this.life + delta));
    if (this.life <= 0) this.failed = true;
  }

  private countTap(tns: TapNoteScore): void {
    this.tapCounts[tns] = (this.tapCounts[tns] ?? 0) + 1;
  }
  private countHold(hns: HoldNoteScore): void {
    this.holdCounts[hns] = (this.holdCounts[hns] ?? 0) + 1;
  }

  private applyTapScore(note: ActiveNote, tns: TapNoteScore, offset: number): void {
    note.tns = tns;
    note.offset = offset;
    note.hidden = true;
    this.lastTns = tns;
    this.judgmentSeq++;
    this.countTap(tns);
    if (!this.failed) this.actualDance += tapDancePoints(tns);

    if (tns !== TapNoteScore.HitMine && tns !== TapNoteScore.AvoidMine) {
      if (tns >= TapNoteScore.W3) {
        this.combo++;
        this.missCombo = 0;
        if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      } else {
        this.combo = 0;
        if (tns === TapNoteScore.Miss) this.missCombo++;
      }
    }
    this.changeLife(tapLifeDelta(tns));
  }

  /** Process a button press (or release) on a column at an audio time. */
  step(track: number, timeSeconds: number, release: boolean): JudgeEvent | null {
    const lane = this.notesByTrack[track];
    if (!lane) return null;

    // Roll re-tap: refill any active roll in this column.
    if (!release) {
      for (const n of lane) {
        if (
          n.isRoll &&
          n.holdInitiated &&
          !n.holdResolved &&
          timeSeconds >= n.time &&
          timeSeconds <= n.tailTime
        ) {
          n.holdLife = 1;
        }
      }
    }

    // Nearest unjudged, judgable note in this column.
    let cand: ActiveNote | null = null;
    let best = Infinity;
    for (const n of lane) {
      if (n.tns !== TapNoteScore.None || !n.judgable) continue;
      const d = Math.abs(n.time - timeSeconds);
      if (d < best) {
        best = d;
        cand = n;
      }
    }
    if (!cand) return null;

    const offset = timeSeconds - cand.time; // negative = early
    const err = Math.abs(offset);
    let tns = TapNoteScore.None;

    switch (cand.note.type) {
      case TapNoteType.Mine:
        if (!release && err <= this.win('mine')) tns = TapNoteScore.HitMine;
        break;
      case TapNoteType.Lift:
        if (release) tns = this.classify(err);
        break;
      case TapNoteType.Tap:
      case TapNoteType.HoldHead:
        if (!release) tns = this.classify(err);
        break;
      default:
        break;
    }

    if (tns === TapNoteScore.None) return null; // stray input / out of window
    this.applyTapScore(cand, tns, offset);
    if (cand.note.type === TapNoteType.HoldHead) {
      cand.holdInitiated = true;
      cand.holdLife = 1;
    }
    return { track, tns, offset, combo: this.combo };
  }

  /** Advance time: age misses and update hold/roll life. `held` = keys down per column. */
  update(nowSeconds: number, held: boolean[] = []): void {
    const dt = Math.max(0, nowSeconds - this.lastUpdate);
    this.lastUpdate = nowSeconds;

    // Age unjudged notes past the miss horizon.
    for (const n of this.notes) {
      if (n.tns !== TapNoteScore.None || !n.judgable) continue;
      if (n.time >= nowSeconds - this.maxWindow) continue;
      if (n.note.type === TapNoteType.Mine) {
        n.tns = TapNoteScore.AvoidMine;
        n.hidden = true;
        this.countTap(TapNoteScore.AvoidMine);
      } else {
        this.applyTapScore(n, TapNoteScore.Miss, this.maxWindow);
        if (n.note.type === TapNoteType.HoldHead) {
          n.hns = HoldNoteScore.Missed;
          n.holdResolved = true;
          this.countHold(HoldNoteScore.Missed);
        }
      }
    }

    // Hold / roll life.
    for (const n of this.notes) {
      if (n.note.type !== TapNoteType.HoldHead || n.holdResolved || !n.holdInitiated) continue;
      const down = held[n.track] ?? false;
      if (nowSeconds > n.time && nowSeconds < n.tailTime) {
        if (n.isRoll) {
          n.holdLife = Math.max(0, n.holdLife - dt / this.win('roll'));
        } else if (down) {
          n.holdLife = 1;
        } else {
          n.holdLife = Math.max(0, n.holdLife - dt / this.win('hold'));
        }
      }
      if (nowSeconds >= n.tailTime) {
        const held2 = n.holdLife > 0;
        n.hns = held2 ? HoldNoteScore.Held : HoldNoteScore.LetGo;
        n.holdResolved = true;
        this.countHold(n.hns);
        if (!this.failed) this.actualDance += holdDancePoints(n.hns);
        this.changeLife(holdLifeDelta(n.hns));
      }
    }
  }

  get percentDancePoints(): number {
    if (this.possibleDance <= 0) return 0;
    return Math.max(0, this.actualDance / this.possibleDance);
  }

  get grade(): string {
    if (this.failed) return 'F';
    let actual = 0;
    for (const k in this.tapCounts) actual += this.tapCounts[k] * tapGradePoints(Number(k));
    for (const k in this.holdCounts) actual += this.holdCounts[k] * holdGradePoints(Number(k));
    const percent = this.possibleGrade > 0 ? actual / this.possibleGrade : 0;
    return gradeFromPercent(percent);
  }
}
