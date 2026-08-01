/**
 * Per-chart statistics for the song-select info panel: the note-type tallies
 * (steps/jumps/hands/holds/rolls/mines/lifts/fakes), a notes-per-second density
 * series with its peak, and the ITG "tech" counts — Crossovers, Footswitches,
 * Sideswitches, Jacks, Brackets.
 *
 * The tech counts come from stepParity.ts, a faithful port of ITGmania's
 * StepParity solver + TechCounts classifier, so they match the game exactly
 * (validated against the compiled C++ — see scripts/techValidate.ts).
 */

import type { NoteData } from '../notes/noteData';
import { noteRowToBeat, TapNoteType } from '../notes/noteTypes';
import type { TimingData } from '../timing/timingData';
import { computeTechCounts, type TechCounts } from './stepParity';

export type { TechCounts };

export interface NpsBin {
  /** Measure start/end in song seconds. */
  t0: number;
  t1: number;
  /** Height 0..1, this measure's NPS over the chart's peak. */
  h: number;
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
  /** 0-based measure index of nps[0] — bins start at the first measure WITH a
   *  note, so labelling bin i as "M{i+1}" is wrong on any chart with a lead-in;
   *  the true measure number of bin i is firstMeasure + i + 1. */
  firstMeasure: number;
}

/** Per-measure notes-per-second series (ITG "density graph"), peak-normalised. */
function computeDensity(
  nd: NoteData,
  timing: TimingData,
): { nps: NpsBin[]; peak: number; firstM: number } {
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
  if (lastM < 0) return { nps: [], peak: 0, firstM: 0 };

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
  if (peak <= 0) return { nps: [], peak: 0, firstM: 0 };
  return {
    nps: raw.map((r) => ({ t0: r.t0, t1: r.t1, h: Math.min(1, r.nps / peak) })),
    peak,
    firstM,
  };
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

  const { nps, peak, firstM } = computeDensity(nd, timing);
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
    tech: computeTechCounts(nd, timing, stepsType),
    nps,
    peakNps: peak,
    lengthSeconds,
    firstMeasure: firstM,
  };
}
