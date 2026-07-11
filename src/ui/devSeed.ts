/**
 * DEV-only leaderboard seeding helper. The e2e (e2e/leaderboard.e2e.mjs) needs
 * to seed real scores on the *highlighted* starter chart, but the v3 server
 * re-simulates every submitted replay against the submitted chart — so a seed
 * has to ship the genuine chart payload AND a replay that actually plays it.
 * The harness can't reach the app's parsed chart, so SongSelect exposes
 * `window.__seedChartData()` (in import.meta.env.DEV only) which returns exactly
 * that for the current highlight: the board hash, the chartData the server
 * rebuilds, and an ideal replay that hits every note (100% baseline). The e2e
 * seeds #1 with the full replay and #2 with a sliced one for a lower score.
 *
 * Not shipped in production — the exposure is gated on import.meta.env.DEV.
 */
import { parseNoteGrid } from '../notes/noteGrid';
import { noteRowToBeat, TapNoteType } from '../notes/noteTypes';
import { chartContentHash } from '../song/chartHash';
import { stepsTypeNumTracks } from '../song/stepsType';
import type { Song } from '../song/song';
import type { Steps } from '../song/steps';
import type { ChartData, ReplayEvent } from '../net/protocol';

const round4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/** Serialize the chart the way Play.tsx does for submission (raw grid + the
 *  timing segments the server rebuilds to recompute the content hash). */
function chartDataOf(song: Song, chart: Steps): ChartData {
  const t = chart.getTimingData(song.timing);
  return {
    stepsType: chart.stepsType,
    noteData: chart.noteDataString,
    timing: {
      offset: t.offsetSeconds,
      bpms: t.bpms.map((s) => ({ row: s.row, bps: s.bps })),
      stops: t.stops.map((s) => ({ row: s.row, seconds: s.seconds })),
      delays: t.delays.map((s) => ({ row: s.row, seconds: s.seconds })),
      warps: t.warps.map((s) => ({ row: s.row, lengthRows: s.lengthRows })),
      fakes: t.fakes.map((s) => ({ row: s.row, lengthRows: s.lengthRows })),
    },
  };
}

/** An ideal replay for a chart: press each tap/hold-head at its exact note time
 *  (W1), hold a hold down until its tail, avoid mines. Re-sims to ~100%. */
function idealReplay(song: Song, chart: Steps): ReplayEvent[] {
  const timing = chart.getTimingData(song.timing);
  const numTracks = stepsTypeNumTracks(chart.stepsType) || 4;
  const nd = parseNoteGrid(chart.noteDataString, numTracks, []);
  const ev: ReplayEvent[] = [];
  for (let track = 0; track < numTracks; track++) {
    for (const { row, note } of nd.getTrack(track)) {
      const t = round4(timing.getElapsedTimeFromBeat(noteRowToBeat(row)));
      if (note.type === TapNoteType.Tap) {
        ev.push({ t, track, up: false }, { t: round4(t + 0.05), track, up: true });
      } else if (note.type === TapNoteType.HoldHead) {
        const tail = round4(timing.getElapsedTimeFromBeat(noteRowToBeat(row + note.durationRows)));
        // Hold the key down from head to tail (no release between = held).
        ev.push({ t, track, up: false }, { t: round4(tail + 0.05), track, up: true });
      } else if (note.type === TapNoteType.Lift) {
        // A lift scores on the release, so release at the note time.
        ev.push({ t: round4(t - 0.05), track, up: false }, { t, track, up: true });
      }
      // Mine: never pressed (avoided).
    }
  }
  return ev.sort((a, b) => a.t - b.t);
}

export interface ChartSeed {
  chartHash: string;
  chartData: ChartData;
  /** An ideal replay of the chart — re-sims to ~100% on the server. */
  perfectReplay: ReplayEvent[];
}

/** Everything the e2e needs to seed a genuine, re-simulatable score. */
export function buildChartSeed(song: Song, chart: Steps): ChartSeed {
  return {
    chartHash: chartContentHash(song, chart),
    chartData: chartDataOf(song, chart),
    perfectReplay: idealReplay(song, chart),
  };
}
