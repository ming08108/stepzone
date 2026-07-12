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
import {
  DEFAULT_WINDOWS,
  missHorizonSeconds,
  windowSeconds,
  type TimingWindows,
  type WindowKey,
} from './windows';

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
  /** W1 hit inside the tight FA+ window — shown white, scored the same. */
  white: boolean;
}

const INITIAL_LIFE = 0.5;
// ITG LifeMeterBar: after a life loss, life gains are withheld until you re-hit
// a few notes (RegenComboAfterMiss=5, capped at MaxRegenComboAfterMiss=5). The
// other default modifiers are no-ops — MercifulDrain=false, ProgressiveLifebar=0,
// and LifeDifficulty resolves to 1.0 (×1 gains, ÷1 losses).
const REGEN_COMBO_AFTER_MISS = 5;
const MAX_REGEN_COMBO = 5;

export class Judge {
  readonly windows: TimingWindows;
  /** Effective (rate-scaled) windows in chart-seconds, computed once — the base
   *  windows, scale, add and rate are all session-constant, so the hot judge
   *  loops read these instead of recomputing base*scale+add every call. */
  private readonly effWin: Record<WindowKey, number>;
  readonly notesByTrack: ActiveNote[][];
  readonly notes: ActiveNote[]; // flat, sorted by time

  combo = 0;
  maxCombo = 0;
  missCombo = 0;
  life = INITIAL_LIFE;
  failed = false;
  /** Display-only score override for a rival's MIRROR judge (live versus): the
   *  rival field is fed judged-note tns for rendering but never re-scored, so
   *  its dance-point accumulators stay empty. The 100 ms snap carries the
   *  rival's real percent — set this from it so their score panel / grade match
   *  their bars. `null` on a real player's judge, which scores itself. */
  displayPercent: number | null = null;

  /** Increments on every tap judgment (hit, miss, or mine) for UI feedback. */
  judgmentSeq = 0;
  lastTns: TapNoteScore = TapNoteScore.None;
  /** Whether the last judgment was a white (FA+) W1 — display only. */
  lastWhite = false;

  readonly tapCounts: Record<number, number> = {};
  readonly holdCounts: Record<number, number> = {};

  private actualDance = 0;
  private possibleDance = 0;
  private possibleGrade = 0;
  private readonly missHorizon: number;
  private lastUpdate = 0;
  /** Hits still owed before life regenerates after a loss (ITG regen-after-miss). */
  private comboToRegainLife = 0;
  // Perf: advance a cursor over the time-sorted notes instead of scanning all
  // of them each frame, and track only the currently-active holds (todo #14).
  private missCursor = 0;
  private readonly activeHolds: ActiveNote[] = [];
  // Per-row combo cohesion (jumps): ITG dance adds one combo per tap, but the
  // continue/break decision is per ROW — settled by the row's WORST tap once
  // every tap in the row has been judged (Player/ScoreKeeperNormal). A single
  // note is just a 1-tap row, so this is identical for streams.
  private readonly rowCombo = new Map<
    number,
    { total: number; judged: number; worst: TapNoteScore }
  >();

  constructor(
    noteData: NoteData,
    timing: TimingData,
    windows: TimingWindows = DEFAULT_WINDOWS,
    rate = 1,
    /**
     * Practice section in chart-seconds: notes outside [startSeconds,
     * endSeconds) are kept (so they still render) but marked unjudgable, like
     * fake notes — never hit, never missed, excluded from possible points.
     */
    section: { startSeconds: number; endSeconds: number } | null = null,
  ) {
    this.windows = windows;
    // Windows are in chart-seconds; at rate r a real ±W is ±(W·r) chart-seconds.
    this.missHorizon = missHorizonSeconds(windows) * rate;
    this.effWin = {
      w0: windowSeconds(windows, 'w0') * rate,
      w1: windowSeconds(windows, 'w1') * rate,
      w2: windowSeconds(windows, 'w2') * rate,
      w3: windowSeconds(windows, 'w3') * rate,
      w4: windowSeconds(windows, 'w4') * rate,
      w5: windowSeconds(windows, 'w5') * rate,
      mine: windowSeconds(windows, 'mine') * rate,
      hold: windowSeconds(windows, 'hold') * rate,
      roll: windowSeconds(windows, 'roll') * rate,
    };
    this.notesByTrack = Array.from({ length: noteData.numTracks }, () => []);
    this.notes = [];

    for (let track = 0; track < noteData.numTracks; track++) {
      for (const { row, note } of noteData.getTrack(track)) {
        if (note.type === TapNoteType.Empty) continue;
        const beat = noteRowToBeat(row);
        const time = timing.getElapsedTimeFromBeat(beat);
        const scoreableType =
          note.type === TapNoteType.Tap ||
          note.type === TapNoteType.HoldHead ||
          note.type === TapNoteType.Mine ||
          note.type === TapNoteType.Lift;
        const inSection =
          section === null || (time >= section.startSeconds && time < section.endSeconds);
        const judgable = scoreableType && inSection && timing.isJudgableAtRow(row);
        const isHoldHead = note.type === TapNoteType.HoldHead;
        const tailRow = isHoldHead ? row + note.durationRows : row;

        const an: ActiveNote = {
          track,
          row,
          beat,
          time,
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
            const rc = this.rowCombo.get(row);
            if (rc) rc.total++;
            else this.rowCombo.set(row, { total: 1, judged: 0, worst: TapNoteScore.W1 });
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

  /**
   * Wipe every judgment and score back to a fresh state for another pass over
   * the same notes (practice-loop replays). The note list and judgable flags
   * are untouched; judgmentSeq deliberately keeps counting so UI layers that
   * diff it don't see a stale match after the reset.
   */
  reset(): void {
    for (const n of this.notes) {
      n.tns = TapNoteScore.None;
      n.offset = 0;
      n.hidden = false;
      n.holdInitiated = false;
      n.holdLife = 1;
      n.hns = HoldNoteScore.None;
      n.holdResolved = false;
    }
    this.combo = 0;
    this.maxCombo = 0;
    this.missCombo = 0;
    this.life = INITIAL_LIFE;
    this.failed = false;
    this.lastTns = TapNoteScore.None;
    this.lastWhite = false;
    for (const k in this.tapCounts) delete this.tapCounts[k];
    for (const k in this.holdCounts) delete this.holdCounts[k];
    this.actualDance = 0;
    this.lastUpdate = 0;
    this.comboToRegainLife = 0;
    this.missCursor = 0;
    this.activeHolds.length = 0;
    for (const rc of this.rowCombo.values()) {
      rc.judged = 0;
      rc.worst = TapNoteScore.W1;
    }
  }

  /** Effective (rate-scaled) window in chart-seconds. */
  private win(key: WindowKey): number {
    return this.effWin[key];
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
    // Regen-after-miss: a loss withholds regeneration for the next few hits.
    // Each non-negative judgment pays one down; while any is owed, gains are
    // zeroed. A loss re-arms it (capped). Matches ITG LifeMeterBar::ChangeLife.
    if (delta >= 0) {
      this.comboToRegainLife = Math.max(this.comboToRegainLife - 1, 0);
      if (this.comboToRegainLife > 0) delta = 0;
    } else {
      this.comboToRegainLife = Math.min(
        MAX_REGEN_COMBO,
        this.comboToRegainLife + REGEN_COMBO_AFTER_MISS,
      );
    }
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
    // `hidden` means consumed by the player's input. A Miss was never touched —
    // it keeps drawing and scrolls off the field like StepMania.
    note.hidden = tns !== TapNoteScore.Miss;
    this.lastTns = tns;
    this.lastWhite = tns === TapNoteScore.W1 && Math.abs(offset) <= this.win('w0');
    this.judgmentSeq++;
    this.countTap(tns);
    if (!this.failed) this.actualDance += tapDancePoints(tns);

    // Combo is decided per ROW (jump cohesion): tally this tap into its row and
    // settle the combo once the whole row is judged, by the row's worst tap.
    if (tns !== TapNoteScore.HitMine && tns !== TapNoteScore.AvoidMine) {
      const rc = this.rowCombo.get(note.row);
      if (rc) {
        rc.judged++;
        if (tns < rc.worst) rc.worst = tns;
        if (rc.judged >= rc.total) this.settleRowCombo(rc);
      }
    }
    this.changeLife(tapLifeDelta(tns));
  }

  /** Apply a fully-judged row's combo: continue (adding one per tap) when its
   *  worst tap is W3+, else break. Only an actual Miss extends the miss combo
   *  (MaxScoreToIncrementMissCombo=Miss, MissComboIsPerRow=true). */
  private settleRowCombo(rc: { total: number; worst: TapNoteScore }): void {
    if (rc.worst >= TapNoteScore.W3) {
      this.combo += rc.total;
      this.missCombo = 0;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    } else {
      this.combo = 0;
      if (rc.worst <= TapNoteScore.Miss) this.missCombo++;
    }
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
      if (!this.activeHolds.includes(cand)) this.activeHolds.push(cand);
    }
    return { track, tns, offset, combo: this.combo, white: this.lastWhite };
  }

  /** Advance time: age misses and update hold/roll life. `held` = keys down per column. */
  update(nowSeconds: number, held: boolean[] = []): void {
    const dt = Math.max(0, nowSeconds - this.lastUpdate);
    this.lastUpdate = nowSeconds;
    const horizon = nowSeconds - this.missHorizon;

    // Age notes past the miss horizon. Notes are time-sorted, so a forward-only
    // cursor visits each note once over the whole song.
    while (this.missCursor < this.notes.length && this.notes[this.missCursor].time < horizon) {
      const n = this.notes[this.missCursor];
      this.missCursor++;
      if (n.tns !== TapNoteScore.None || !n.judgable) continue;
      if (n.note.type === TapNoteType.Mine) {
        // Avoided mines aren't consumed — they scroll off the field visibly.
        n.tns = TapNoteScore.AvoidMine;
        this.countTap(TapNoteScore.AvoidMine);
      } else {
        // A Miss has no real timing offset; record the late w5 edge, not the
        // (much larger) roll drop-timer that used to leak in here.
        this.applyTapScore(n, TapNoteScore.Miss, this.win('w5'));
        if (n.note.type === TapNoteType.HoldHead) {
          n.hns = HoldNoteScore.Missed;
          n.holdResolved = true;
          this.countHold(HoldNoteScore.Missed);
        }
      }
    }

    // Hold / roll life — only the holds currently in progress.
    for (let i = this.activeHolds.length - 1; i >= 0; i--) {
      const n = this.activeHolds[i];
      if (n.holdResolved) {
        this.activeHolds.splice(i, 1);
        continue;
      }
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
      // ITG's ImmediateHoldLetGo (on for dance): the moment an initiated
      // hold/roll's life drains to zero it is scored LetGo and latched —
      // re-pressing must not resurrect it to Held at the tail. Combo is
      // untouched (ComboBreakOnImmediateHoldLetGo is off in the dance default).
      if (n.holdLife <= 0) {
        this.resolveHold(n, HoldNoteScore.LetGo, i);
        continue;
      }
      if (nowSeconds >= n.tailTime) {
        this.resolveHold(n, HoldNoteScore.Held, i);
      }
    }
  }

  /** Score a live hold (Held at the tail, or LetGo the moment life hits 0). */
  private resolveHold(n: ActiveNote, hns: HoldNoteScore, activeIdx: number): void {
    n.hns = hns;
    n.holdResolved = true;
    this.countHold(hns);
    if (!this.failed) this.actualDance += holdDancePoints(hns);
    this.changeLife(holdLifeDelta(hns));
    this.activeHolds.splice(activeIdx, 1);
  }

  get percentDancePoints(): number {
    if (this.displayPercent !== null) return this.displayPercent;
    if (this.possibleDance <= 0) return 0;
    return Math.max(0, this.actualDance / this.possibleDance);
  }

  get grade(): string {
    if (this.failed) return 'F';
    // A rival mirror judge has no per-tap counts (only a streamed percent), so
    // derive its grade from that so its letter matches its displayed score.
    if (this.displayPercent !== null) return gradeFromPercent(this.displayPercent);
    let actual = 0;
    for (const k in this.tapCounts) actual += this.tapCounts[k] * tapGradePoints(Number(k));
    for (const k in this.holdCounts) actual += this.holdCounts[k] * holdGradePoints(Number(k));
    const percent = this.possibleGrade > 0 ? actual / this.possibleGrade : 0;
    return gradeFromPercent(percent);
  }
}
