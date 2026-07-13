/**
 * Builds the config for the procedural GPU attract background (variant + the
 * dancer's step timeline) from a chart. Shared by the play screen and the
 * Player Options preview so both drive the dance background identically.
 */
import { computeFootPlacements } from '../analysis/stepParity';
import { noteRowToBeat, TapNoteType } from '../notes/noteTypes';
import type { AttractConfig } from './gpu/attractGpu';
import type { Steps } from '../song/steps';
import type { TimingData } from '../timing/timingData';

/** A stable attract variant (0..3) from the song title, so a song always gets
 *  the same mood but different songs vary. */
export const attractVariant = (title: string): number => {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0;
  return Math.abs(h) % 4;
};

/** Map a chart column (of `n` tracks) to a dance direction 0=L,1=D,2=U,3=R.
 *  dance-single is exact; other layouts fold columns left→right for a sensible
 *  approximation so the attract dancer still steps to their notes. */
const columnToDir = (col: number, n: number): number => {
  if (n === 4) return col;
  const f = n <= 1 ? 0.5 : col / (n - 1); // 0..1 across the pad
  if (f < 0.28) return 0; // Left
  if (f > 0.72) return 3; // Right
  return col % 2 === 0 ? 2 : 1; // middle panels → alternate Up/Down
};

/** The chart's steppable notes as an attract-dancer timeline: one entry per note
 *  row with its beat and a 4-bit L/D/U/R column mask (a jump lights >1 bit).
 *  Mines, fakes, and hold tails don't make her step. */
const chartSteps = (chart: Steps): { beat: number; cols: number }[] => {
  const nd = chart.getNoteData();
  const n = nd.numTracks;
  const byRow = new Map<number, number>();
  for (let c = 0; c < n; c++) {
    for (const { row, note } of nd.getTrack(c)) {
      if (
        note.type === TapNoteType.Tap ||
        note.type === TapNoteType.HoldHead ||
        note.type === TapNoteType.Lift
      ) {
        byRow.set(row, (byRow.get(row) ?? 0) | (1 << columnToDir(c, n)));
      }
    }
  }
  return [...byRow.entries()]
    .map(([row, cols]) => ({ beat: noteRowToBeat(row), cols }))
    .sort((a, b) => a.beat - b.beat);
};

/** The attract dancer's step timeline for a chart. Prefer the StepParity
 *  foot-placement solve (so the dancer foots the chart exactly as a player
 *  would, crossovers and all); fall back to the naive column mask for steps
 *  types the solver doesn't cover. */
const dancerSteps = (
  timing: TimingData,
  chart: Steps,
): { beat: number; cols: number; lCol?: number; rCol?: number }[] => {
  const footed = computeFootPlacements(chart.getNoteData(), timing, chart.stepsType);
  return footed ?? chartSteps(chart);
};

/** The full attract config (mood variant + chart-stepping timeline) for a song. */
export const buildAttractConfig = (
  title: string,
  timing: TimingData,
  chart: Steps,
): AttractConfig => ({
  variant: attractVariant(title),
  steps: dancerSteps(timing, chart),
});
