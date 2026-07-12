/**
 * Per-chart statistics for the song-select info panel: the note-type tallies
 * (steps/jumps/hands/holds/rolls/mines/lifts/fakes), a notes-per-second density
 * series with its peak, and the ITG "tech" counts — Crossovers, Footswitches,
 * Sideswitches, Jacks, Brackets.
 *
 * The tech counts follow ITGmania's TechCounts.cpp classification verbatim (same
 * timing cut-offs, same crossover/footswitch/jack/bracket rules). ITGmania feeds
 * that classifier a foot assignment produced by its full cost-minimising
 * StepParity solver (~900 lines of C++); porting that is out of scope, so we
 * assign feet with a light greedy model instead: strict alternation for streams
 * (which is what the solver picks there anyway), same-foot on a fast repeated
 * arrow (a jack), and one-foot brackets only when the other foot is pinned by a
 * live hold. The classification then derives the counts from that assignment, so
 * on ordinary charts the numbers track ITGmania closely; on ambiguous tech the
 * greedy assignment can differ, so treat these as a very close approximation.
 */

import type { NoteData } from '../notes/noteData';
import { noteRowToBeat, TapNoteType } from '../notes/noteTypes';
import type { TimingData } from '../timing/timingData';

// Timing cut-offs, in seconds (ITGmania TechCounts.cpp).
const JACK_CUTOFF = 0.176; // ~1/8th at 175bpm — slower repeats aren't jacks
const FOOTSWITCH_CUTOFF = 0.3; // ~1/4th at 200bpm — slower swaps aren't footswitches

// Foot parts (ITGmania StepParity::Foot). 0 = no foot on the column.
const NONE = 0;
const LH = 1; // left heel
const LT = 2; // left toe
const RH = 3; // right heel
const RT = 4; // right toe
const FEET = [LH, LT, RH, RT] as const;
const OTHER_PART = [NONE, LT, LH, RT, RH]; // the other part of the same foot
const isLeft = (f: number): boolean => f === LH || f === LT;
const otherFoot = (heel: number): number => (heel === LH ? RH : LH);

export interface NpsBin {
  /** Measure start/end in song seconds. */
  t0: number;
  t1: number;
  /** Height 0..1, this measure's NPS over the chart's peak. */
  h: number;
}

export interface TechCounts {
  crossovers: number;
  footswitches: number;
  sideswitches: number;
  jacks: number;
  brackets: number;
}

export interface ChartStats {
  steps: number; // distinct step rows (a jump/hand counts once)
  jumps: number; // rows with >= 2 simultaneous
  hands: number; // rows with >= 3 simultaneous
  holds: number;
  rolls: number;
  mines: number;
  lifts: number;
  fakes: number;
  /** Tech counts, or null for a steps-type we don't model (non dance-single/double). */
  tech: TechCounts | null;
  nps: NpsBin[];
  peakNps: number;
  lengthSeconds: number;
}

interface Layout {
  colX: number[];
  colY: number[];
  up: number[];
  down: number[];
  side: number[];
}

/** Panel geometry for the tech model: two 4-panel pads laid left→right. */
function layoutFor(stepsType: string): Layout | null {
  if (stepsType === 'dance-single' || stepsType === 'techno-single4') {
    return { colX: [0, 1, 1, 2], colY: [1, 2, 0, 1], up: [2], down: [1], side: [0, 3] };
  }
  if (
    stepsType === 'dance-double' ||
    stepsType === 'dance-couple' ||
    stepsType === 'dance-routine'
  ) {
    return {
      colX: [0, 1, 1, 2, 3, 4, 4, 5],
      colY: [1, 2, 0, 1, 1, 2, 0, 1],
      up: [2, 6],
      down: [1, 5],
      side: [0, 3, 4, 7],
    };
  }
  return null;
}

/** One step row after foot assignment (mirrors StepParity::Row's tech fields). */
interface FootRow {
  second: number;
  noteCount: number;
  /** Column each foot part hit this row, or -1. */
  feet: [number, number, number, number, number]; // indexed by foot constant
  /** Foot on each column this row, NONE if unhit. */
  colFoot: number[];
}

interface RawNote {
  col: number;
  hold: boolean;
  endRow: number;
}

/**
 * Group the chart's tap/hold/lift notes into rows (time-ordered), assign feet,
 * then run the ITGmania classification. Returns null if the steps-type is not
 * modelled.
 */
function computeTech(nd: NoteData, timing: TimingData, stepsType: string): TechCounts | null {
  const layout = layoutFor(stepsType);
  if (!layout) return null;
  const numTracks = nd.numTracks;

  // Gather step notes by row (taps, hold/roll heads, lifts — not mines/fakes).
  const byRow = new Map<number, RawNote[]>();
  for (let c = 0; c < numTracks; c++) {
    for (const { row, note } of nd.getTrack(c)) {
      const isHead = note.type === TapNoteType.HoldHead;
      if (note.type !== TapNoteType.Tap && !isHead && note.type !== TapNoteType.Lift) continue;
      const list = byRow.get(row) ?? [];
      list.push({ col: c, hold: isHead, endRow: isHead ? row + note.durationRows : row });
      byRow.set(row, list);
    }
  }
  const rowKeys = [...byRow.keys()].sort((a, b) => a - b);

  const center = (Math.min(...layout.colX) + Math.max(...layout.colX)) / 2;
  const dist2 = (a: number, b: number): number =>
    (layout.colX[a] - layout.colX[b]) ** 2 + (layout.colY[a] - layout.colY[b]) ** 2;

  // Assignment bookkeeping carried across rows.
  let lastFoot = NONE; // last single-step foot (LH/RH), NONE after a jump/bracket
  let lastSecond = 0;
  const footLastCol: Record<number, number> = { [LH]: -1, [RH]: -1 };
  const activeHolds = new Map<number, { foot: number; end: number }>(); // col → foot/end

  // The next single-note row's column at or after key index `ki` (for choosing a
  // crossover-avoiding first foot). -1 if none.
  const nextSingleCol = (ki: number): number => {
    for (let k = ki; k < rowKeys.length; k++) {
      const nn = byRow.get(rowKeys[k])!;
      if (nn.length === 1) return nn[0].col;
    }
    return -1;
  };

  const rows: FootRow[] = [];

  for (let ki = 0; ki < rowKeys.length; ki++) {
    const rowIndex = rowKeys[ki];
    const notes = byRow.get(rowIndex)!;
    const second = timing.getElapsedTimeFromBeat(noteRowToBeat(rowIndex));
    // Expire holds that ended before this row.
    for (const [col, h] of activeHolds) if (rowIndex >= h.end) activeHolds.delete(col);

    const feet: FootRow['feet'] = [-1, -1, -1, -1, -1];
    const colFoot = new Array(numTracks).fill(NONE);
    const cols = notes.map((n) => n.col);
    const nc = cols.length;

    const place = (foot: number, col: number): void => {
      feet[foot] = col;
      colFoot[col] = foot;
    };

    // Which foot (if any) is pinned by a hold that's still ringing out.
    const heldFeet = new Set([...activeHolds.values()].map((h) => h.foot));
    const leftPinned = [...heldFeet].some(isLeft);
    const rightPinned = [...heldFeet].some((f) => !isLeft(f));

    if (nc === 1) {
      const c = cols[0];
      let foot: number;
      if (leftPinned !== rightPinned) {
        // One foot is holding — the other foot must take this tap (no alternation,
        // no crossover: this is where doublesteps/jacks come from).
        foot = leftPinned ? RH : LH;
      } else if (lastFoot === NONE) {
        // Choose the first foot so the following arrow doesn't force a crossover:
        // if the next step is to our right, lead with the left foot (and vice
        // versa). Ties (same x, e.g. up→down) fall back to the column's own side.
        const nx = nextSingleCol(ki + 1);
        if (nx === -1 || layout.colX[nx] === layout.colX[c]) {
          foot = layout.colX[c] <= center ? LH : RH;
        } else {
          foot = layout.colX[nx] > layout.colX[c] ? LH : RH;
        }
      } else if (c === footLastCol[lastFoot]) {
        // Same arrow the same foot just hit. Default to the SAME foot again — the
        // natural, crossover-free choice (a jack if it's fast). The one exception
        // is a fast repeat on a centre (up/down) arrow, which a player footswitches
        // with alternating feet — and doing so on centre can't cross.
        const isCenter = layout.up.includes(c) || layout.down.includes(c);
        foot = isCenter && second - lastSecond < FOOTSWITCH_CUTOFF ? otherFoot(lastFoot) : lastFoot;
      } else {
        // Alternate. ITGmania's parity solver weights a doublestep (cost 850) far
        // above a crossover (a small facing penalty), so it keeps alternating even
        // when that means crossing over — we do the same and let the classifier
        // count the crossover.
        foot = otherFoot(lastFoot);
      }
      place(foot, c);
      lastFoot = foot;
      footLastCol[foot] = c;
    } else {
      // A jump/hand — or a bracket if the other foot is pinned by a live hold and
      // the two notes are reachable by one foot.
      const sorted = cols.slice().sort((a, b) => layout.colX[a] - layout.colX[b]);
      if (nc === 2 && leftPinned !== rightPinned && dist2(sorted[0], sorted[1]) <= 2) {
        const freeIsLeft = !leftPinned;
        place(freeIsLeft ? LH : RH, sorted[0]);
        place(freeIsLeft ? LT : RT, sorted[1]);
        footLastCol[freeIsLeft ? LH : RH] = sorted[0];
      } else {
        // Jump/hand: fill from the outside in — leftmost→left foot, rightmost→right.
        const slots = [LH, LT, RH, RT];
        sorted.forEach((c, k) => {
          if (k < 4) place(slots[k], c);
        });
        footLastCol[LH] = sorted[0];
        footLastCol[RH] = sorted[sorted.length - 1];
      }
      lastFoot = NONE; // ambiguous which foot leads out of a jump
    }

    // Register any holds started on this row against the foot that took them.
    for (const n of notes) {
      if (n.hold && colFoot[n.col] !== NONE) {
        activeHolds.set(n.col, { foot: colFoot[n.col], end: n.endRow });
      }
    }

    lastSecond = second;
    rows.push({ second, noteCount: nc, feet, colFoot });
  }

  return classify(rows, layout);
}

/** Average x of a foot's heel/toe columns (ITGmania StageLayout::averagePoint.x). */
function avgX(layout: Layout, heelCol: number, toeCol: number): number {
  if (heelCol === -1 && toeCol === -1) return 0;
  if (heelCol === -1) return layout.colX[toeCol];
  if (toeCol === -1) return layout.colX[heelCol];
  return (layout.colX[heelCol] + layout.colX[toeCol]) / 2;
}

function isFootswitch(c: number, cur: FootRow, prev: FootRow, dt: number): boolean {
  if (cur.colFoot[c] === NONE || prev.colFoot[c] === NONE) return false;
  return (
    prev.colFoot[c] !== cur.colFoot[c] &&
    OTHER_PART[prev.colFoot[c]] !== cur.colFoot[c] &&
    dt < FOOTSWITCH_CUTOFF
  );
}

/** ITGmania TechCounts::CalculateTechCountsFromRows, ported. */
function classify(rows: FootRow[], layout: Layout): TechCounts {
  const t: TechCounts = { crossovers: 0, footswitches: 0, sideswitches: 0, jacks: 0, brackets: 0 };

  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];

    // Brackets: one foot's heel and toe both landed this row.
    if (cur.noteCount >= 2) {
      if (cur.feet[LH] !== -1 && cur.feet[LT] !== -1) t.brackets++;
      if (cur.feet[RH] !== -1 && cur.feet[RT] !== -1) t.brackets++;
    }
    if (i === 0) continue;

    const prev = rows[i - 1];
    const dt = cur.second - prev.second;

    // Jacks: same foot, same arrow, on back-to-back single rows, fast.
    if (cur.noteCount === 1 && prev.noteCount === 1) {
      for (const foot of FEET) {
        if (cur.feet[foot] === -1 || prev.feet[foot] === -1) continue;
        if (prev.feet[foot] === cur.feet[foot] && dt < JACK_CUTOFF) t.jacks++;
      }
    }

    // Footswitch on an up/down arrow, sideswitch on a side arrow.
    for (const c of layout.up) if (isFootswitch(c, cur, prev, dt)) t.footswitches++;
    for (const c of layout.down) if (isFootswitch(c, cur, prev, dt)) t.footswitches++;
    for (const c of layout.side) if (isFootswitch(c, cur, prev, dt)) t.sideswitches++;

    // Crossovers: one foot reached across to the far side of the other.
    const [, lh, lt, rh, rt] = cur.feet;
    const [, plh, plt, prh, prt] = prev.feet;
    if (rh !== -1 && plh !== -1 && prh === -1) {
      if (avgX(layout, rh, rt) < avgX(layout, plh, plt)) {
        if (i > 1) {
          const pprh = rows[i - 2].feet[RH];
          if (pprh !== -1 && pprh !== rh) t.crossovers++;
        } else {
          t.crossovers++;
        }
      }
    } else if (lh !== -1 && prh !== -1 && plh === -1) {
      if (avgX(layout, prh, prt) < avgX(layout, lh, lt)) {
        if (i > 1) {
          const pplh = rows[i - 2].feet[LH];
          if (pplh !== -1 && pplh !== lh) t.crossovers++;
        } else {
          t.crossovers++;
        }
      }
    }
  }
  return t;
}

/** Per-measure notes-per-second series (ITG "density graph"), peak-normalised. */
function computeDensity(nd: NoteData, timing: TimingData): { nps: NpsBin[]; peak: number } {
  const counts = new Map<number, number>();
  let firstM = Infinity;
  let lastM = -1;
  for (let c = 0; c < nd.numTracks; c++) {
    for (const { row, note } of nd.getTrack(c)) {
      if (
        note.type !== TapNoteType.Tap &&
        note.type !== TapNoteType.HoldHead &&
        note.type !== TapNoteType.Lift
      )
        continue;
      const m = Math.floor(noteRowToBeat(row) / 4);
      counts.set(m, (counts.get(m) ?? 0) + 1);
      if (m < firstM) firstM = m;
      if (m > lastM) lastM = m;
    }
  }
  if (lastM < 0) return { nps: [], peak: 0 };

  const raw: Array<{ t0: number; t1: number; nps: number }> = [];
  let peak = 0;
  let t0 = timing.getElapsedTimeFromBeat(firstM * 4);
  for (let m = firstM; m <= lastM; m++) {
    const t1 = timing.getElapsedTimeFromBeat((m + 1) * 4);
    const nps = (counts.get(m) ?? 0) / Math.max(0.001, t1 - t0);
    raw.push({ t0, t1, nps });
    if (nps > peak) peak = nps;
    t0 = t1;
  }
  if (peak <= 0) return { nps: [], peak: 0 };
  return { nps: raw.map((r) => ({ t0: r.t0, t1: r.t1, h: Math.min(1, r.nps / peak) })), peak };
}

/** All song-select stats for one chart. */
export function computeChartStats(nd: NoteData, timing: TimingData, stepsType: string): ChartStats {
  const c = nd.computeCounts();

  // Distinct step rows (a jump/hand counts once): union of rows across tracks.
  const stepRows = new Set<number>();
  for (let col = 0; col < nd.numTracks; col++) {
    for (const { row, note } of nd.getTrack(col)) {
      if (
        note.type === TapNoteType.Tap ||
        note.type === TapNoteType.HoldHead ||
        note.type === TapNoteType.Lift
      )
        stepRows.add(row);
    }
  }

  const { nps, peak } = computeDensity(nd, timing);
  const lengthSeconds = timing.getElapsedTimeFromBeat(noteRowToBeat(nd.lastRow()));

  return {
    steps: stepRows.size,
    jumps: c.jumps,
    hands: c.hands,
    holds: c.holdHeads,
    rolls: c.rollHeads,
    mines: c.mines,
    lifts: c.lifts,
    fakes: c.fakes,
    tech: computeTech(nd, timing, stepsType),
    nps,
    peakNps: peak,
    lengthSeconds,
  };
}
