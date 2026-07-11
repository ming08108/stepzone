/**
 * Serialize a chart into the wire payload a leaderboard submission ships so the
 * server can re-simulate the replay against it (docs/LEADERBOARDS.md): the raw
 * note grid plus the timing segments the server rebuilds to recompute the
 * content hash and re-run the Judge. Shared by the submit path (Play) and the
 * DEV seed hook so the two can't drift.
 */
import type { ChartData } from '../net/protocol';
import type { Song } from './song';
import type { Steps } from './steps';

export function chartDataOf(song: Song, chart: Steps): ChartData {
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
