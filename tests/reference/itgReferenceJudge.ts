/**
 * Independent reference judge — a deliberately-separate transcription of
 * ITGmania's judgment (Player.cpp classify + GetClosestNote, ScoreKeeperNormal
 * combo/score, LifeMeterBar life), with the metric constants hard-coded from the
 * source rather than shared with src/. Used only by parity.test.ts to diff our
 * engine against a from-source implementation over real charts. Not shipped.
 */
import { NoteData } from '../../src/notes/noteData';
import { TimingData } from '../../src/timing/timingData';
import {
  noteRowToBeat,
  TapNoteScore,
  TapNoteSubType,
  TapNoteType,
} from '../../src/notes/noteTypes';

// --- Constants transcribed from ITGmania source (not imported from src/) ------
// Player.cpp TimingWindowSecondsInit + TimingWindowScale=1, Add=0.
const WIN = {
  w1: 0.0225,
  w2: 0.045,
  w3: 0.09,
  w4: 0.135,
  w5: 0.18,
  mine: 0.09,
  hold: 0.25,
  roll: 0.5,
};
// _fallback metrics ScoreKeeperNormal.PercentScoreWeight* / GradeWeight*.
const DP = { W1: 3, W2: 2, W3: 1, HitMine: -2, Held: 3 } as Record<string, number>;
const GP = { W1: 2, W2: 2, W3: 1, W5: -4, Miss: -8, HitMine: -8, Held: 6 } as Record<
  string,
  number
>;
// _fallback metrics LifeMeterBar.LifePercentChange*.
const LP: Record<string, number> = {
  W1: 0.008,
  W2: 0.008,
  W3: 0.004,
  W4: 0,
  W5: -0.04,
  Miss: -0.08,
  HitMine: -0.16,
  Held: 0.008,
  LetGo: -0.08,
};
const INITIAL_LIFE = 0.5;
const REGEN_AFTER_MISS = 5; // Prefs RegenComboAfterMiss
const MAX_REGEN = 5; // Prefs MaxRegenComboAfterMiss
const STEP_SEARCH = 1.0; // Player.cpp StepSearchDistance (seconds)

enum HNS {
  None,
  Held,
  LetGo,
  Missed,
}

interface RNote {
  track: number;
  row: number;
  time: number;
  type: TapNoteType;
  isHold: boolean;
  isRoll: boolean;
  tailTime: number;
  judgable: boolean;
  tns: TapNoteScore;
  hns: HNS;
  offset: number;
  // hold runtime
  initiated: boolean;
  life: number;
  resolved: boolean;
}

const nameOf: Record<number, string> = {
  [TapNoteScore.W1]: 'W1',
  [TapNoteScore.W2]: 'W2',
  [TapNoteScore.W3]: 'W3',
  [TapNoteScore.W4]: 'W4',
  [TapNoteScore.W5]: 'W5',
  [TapNoteScore.Miss]: 'Miss',
  [TapNoteScore.HitMine]: 'HitMine',
};

/** Faithful-to-source reference. Same public surface as src Judge for the diff. */
export class RefJudge {
  readonly notesByTrack: RNote[][];
  readonly notes: RNote[];
  combo = 0;
  maxCombo = 0;
  life = INITIAL_LIFE;
  failed = false;
  readonly tapCounts: Record<number, number> = {};
  readonly holdCounts: Record<number, number> = {};

  private actualDP = 0;
  private possibleDP = 0;
  private actualGP = 0;
  private possibleGP = 0;
  private comboToRegain = 0;
  private lastUpdate = 0;
  private readonly rows = new Map<number, { total: number; judged: number; worst: TapNoteScore }>();

  constructor(nd: NoteData, timing: TimingData) {
    this.notesByTrack = Array.from({ length: nd.numTracks }, () => []);
    this.notes = [];
    for (let track = 0; track < nd.numTracks; track++) {
      for (const { row, note } of nd.getTrack(track)) {
        if (note.type === TapNoteType.Empty) continue;
        const beat = noteRowToBeat(row);
        const time = timing.getElapsedTimeFromBeat(beat);
        const scoreable =
          note.type === TapNoteType.Tap ||
          note.type === TapNoteType.HoldHead ||
          note.type === TapNoteType.Mine ||
          note.type === TapNoteType.Lift;
        const judgable = scoreable && timing.isJudgableAtRow(row);
        const isHold = note.type === TapNoteType.HoldHead;
        const tailRow = isHold ? row + note.durationRows : row;
        const n: RNote = {
          track,
          row,
          time,
          type: note.type,
          isHold: isHold && note.subType === TapNoteSubType.Hold,
          isRoll: isHold && note.subType === TapNoteSubType.Roll,
          tailTime: timing.getElapsedTimeFromBeat(noteRowToBeat(tailRow)),
          judgable,
          tns: TapNoteScore.None,
          hns: HNS.None,
          offset: 0,
          initiated: false,
          life: 1,
          resolved: false,
        };
        this.notesByTrack[track].push(n);
        this.notes.push(n);
        if (judgable && note.type !== TapNoteType.Mine) {
          this.possibleDP += DP.W1;
          this.possibleGP += GP.W1;
          const rc = this.rows.get(row);
          if (rc) rc.total++;
          else this.rows.set(row, { total: 1, judged: 0, worst: TapNoteScore.W1 });
        }
        if (judgable && isHold) {
          this.possibleDP += DP.Held;
          this.possibleGP += GP.Held;
        }
      }
    }
    this.notes.sort((a, b) => a.time - b.time || a.track - b.track);
  }

  private classify(off: number): TapNoteScore {
    const a = Math.abs(off);
    if (a <= WIN.w1) return TapNoteScore.W1;
    if (a <= WIN.w2) return TapNoteScore.W2;
    if (a <= WIN.w3) return TapNoteScore.W3;
    if (a <= WIN.w4) return TapNoteScore.W4;
    if (a <= WIN.w5) return TapNoteScore.W5;
    return TapNoteScore.None;
  }

  private changeLife(d: number): void {
    if (this.failed) return;
    if (d >= 0) {
      this.comboToRegain = Math.max(this.comboToRegain - 1, 0);
      if (this.comboToRegain > 0) d = 0;
    } else {
      this.comboToRegain = Math.min(MAX_REGEN, this.comboToRegain + REGEN_AFTER_MISS);
    }
    this.life = Math.min(1, Math.max(0, this.life + d));
    if (this.life <= 0) this.failed = true;
  }

  private settleRow(row: number, tns: TapNoteScore): void {
    const rc = this.rows.get(row);
    if (!rc) return;
    rc.judged++;
    if (tns < rc.worst) rc.worst = tns;
    if (rc.judged < rc.total) return;
    if (rc.worst >= TapNoteScore.W3) {
      this.combo += rc.total;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    } else {
      this.combo = 0;
    }
  }

  private applyTap(n: RNote, tns: TapNoteScore, off: number): void {
    n.tns = tns;
    n.offset = off;
    this.tapCounts[tns] = (this.tapCounts[tns] ?? 0) + 1;
    if (!this.failed) {
      this.actualDP += DP[nameOf[tns]] ?? 0;
      this.actualGP += GP[nameOf[tns]] ?? 0;
    }
    if (tns !== TapNoteScore.HitMine) this.settleRow(n.row, tns);
    this.changeLife(LP[nameOf[tns]] ?? 0);
  }

  step(track: number, t: number, release: boolean): void {
    const lane = this.notesByTrack[track];
    if (!lane) return;
    if (!release) {
      for (const n of lane)
        if (n.isRoll && n.initiated && !n.resolved && t >= n.time && t <= n.tailTime) n.life = 1;
    }
    // GetClosestNote: nearest un-graded note in the column within the search window.
    let cand: RNote | null = null;
    let best = STEP_SEARCH;
    for (const n of lane) {
      if (n.tns !== TapNoteScore.None || !n.judgable) continue;
      const d = Math.abs(n.time - t);
      if (d < best) {
        best = d;
        cand = n;
      }
    }
    if (!cand) return;
    const off = t - cand.time;
    let tns = TapNoteScore.None;
    if (cand.type === TapNoteType.Mine) {
      if (!release && Math.abs(off) <= WIN.mine) tns = TapNoteScore.HitMine;
    } else if (cand.type === TapNoteType.Lift) {
      if (release) tns = this.classify(off);
    } else if (!release) {
      tns = this.classify(off);
    }
    if (tns === TapNoteScore.None) return;
    this.applyTap(cand, tns, off);
    if (cand.type === TapNoteType.HoldHead) {
      cand.initiated = true;
      cand.life = 1;
    }
  }

  update(now: number, held: boolean[] = []): void {
    const dt = Math.max(0, now - this.lastUpdate);
    this.lastUpdate = now;
    const horizon = now - WIN.w5;
    for (const n of this.notes) {
      if (n.time >= horizon) break; // time-sorted
      if (n.tns !== TapNoteScore.None || !n.judgable) continue;
      if (n.type === TapNoteType.Mine) {
        n.tns = TapNoteScore.AvoidMine;
        this.tapCounts[TapNoteScore.AvoidMine] = (this.tapCounts[TapNoteScore.AvoidMine] ?? 0) + 1;
      } else {
        this.applyTap(n, TapNoteScore.Miss, WIN.w5);
        if (n.type === TapNoteType.HoldHead) {
          n.hns = HNS.Missed;
          n.resolved = true;
          this.holdCounts[HNS.Missed] = (this.holdCounts[HNS.Missed] ?? 0) + 1;
        }
      }
    }
    for (const n of this.notes) {
      if (n.type !== TapNoteType.HoldHead || !n.initiated || n.resolved) continue;
      if (now > n.time && now < n.tailTime) {
        if (n.isRoll) n.life = Math.max(0, n.life - dt / WIN.roll);
        else if (held[n.track]) n.life = 1;
        else n.life = Math.max(0, n.life - dt / WIN.hold);
      }
      if (n.life <= 0) this.resolveHold(n, HNS.LetGo);
      else if (now >= n.tailTime) this.resolveHold(n, HNS.Held);
    }
  }

  private resolveHold(n: RNote, hns: HNS): void {
    n.hns = hns;
    n.resolved = true;
    this.holdCounts[hns] = (this.holdCounts[hns] ?? 0) + 1;
    const key = hns === HNS.Held ? 'Held' : hns === HNS.LetGo ? 'LetGo' : '';
    if (!this.failed) {
      this.actualDP += DP[key] ?? 0;
      this.actualGP += GP[key] ?? 0;
    }
    this.changeLife(LP[key] ?? 0);
  }

  get percentDancePoints(): number {
    return this.possibleDP <= 0 ? 0 : Math.max(0, this.actualDP / this.possibleDP);
  }
}
