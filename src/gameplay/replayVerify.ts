/**
 * Server-side replay verification — the real anti-cheat (docs/LEADERBOARDS.md).
 *
 * A leaderboard submission can't be trusted to report its own score: the client
 * controls every field. So the server RE-RUNS the play. It rebuilds the chart
 * from the submitted `chartData`, confirms that chart hashes to the board the
 * submission claims (so no easier substitute), then drives the real Judge with
 * the submitted replay and derives the score from what the inputs ACTUALLY
 * produce. Forged percents/grades/combos are ignored — the stored score is the
 * re-simulated one. The residual is a bot/TAS that genuinely plays the chart,
 * the irreducible limit for any rhythm game.
 *
 * Pure engine code (Judge/TimingData/NoteData), so it bundles into the
 * serverless scores function and is unit-tested in Node. The re-sim mirrors
 * GameSession's loop: apply each input at its recorded time through the same
 * step() path, and tick update() on a fixed fine timestep so misses age and
 * holds resolve exactly as they do live.
 */

import { parseNoteGrid } from '../notes/noteGrid';
import { hashChartContent } from '../song/chartHash';
import { stepsTypeNumTracks } from '../song/stepsType';
import { TimingData } from '../timing/timingData';
import type { ChartData, PlayResult, ReplayEvent } from '../net/protocol';
import { Judge } from './judge';
import { DEFAULT_WINDOWS } from './windows';

/** Re-sim tick — finer than any real display refresh, so hold-life drain and
 *  miss aging resolve at least as precisely as the live play did. */
const SIM_STEP_SECONDS = 1 / 300;
/** Run the judge this far past the last note so trailing misses/holds settle. */
const SIM_TAIL_SECONDS = 3;
/** Cap the fine-stepped window (anti-DoS): a crafted chart can push note times
 *  arbitrarily far out (tiny BPM), so the per-frame loop is bounded here and a
 *  single coarse update past the true end ages any remaining notes to Miss. No
 *  real play — marathons included — runs anywhere near an hour. */
const MAX_FINE_SIM_SECONDS = 3600;

/** Rebuild the resolved TimingData from the wire segments (the same object the
 *  client hashed and judged on). Only beat<->time + judgability segments cross
 *  the wire; the rest never affect scoring. */
export function reconstructTiming(timing: ChartData['timing']): TimingData {
  const t = new TimingData();
  t.offsetSeconds = timing.offset;
  t.bpms = timing.bpms.map((s) => ({ row: s.row, bps: s.bps }));
  t.stops = timing.stops.map((s) => ({ row: s.row, seconds: s.seconds }));
  t.delays = timing.delays.map((s) => ({ row: s.row, seconds: s.seconds }));
  t.warps = timing.warps.map((s) => ({ row: s.row, lengthRows: s.lengthRows }));
  t.fakes = timing.fakes.map((s) => ({ row: s.row, lengthRows: s.lengthRows }));
  t.tidy(); // sort + guarantee a row-0 BPM, exactly like the parser does
  return t;
}

/** Derive a PlayResult from a settled Judge — the same fields the client reads. */
function resultOf(judge: Judge): PlayResult {
  return {
    percent: Math.max(0, Math.min(1, judge.percentDancePoints)),
    grade: judge.grade,
    maxCombo: judge.maxCombo,
    failed: judge.failed,
    counts: { ...judge.tapCounts },
    holdCounts: { ...judge.holdCounts },
  };
}

/**
 * Re-simulate a replay against a chart and return the authoritative result.
 * Returns { reject } when the chart doesn't hash to the claimed board (the
 * submission is lying about which chart it played), else { result }.
 */
export function verifyReplay(
  chartData: ChartData,
  expectedChartHash: string,
  replay: ReplayEvent[],
  musicRate: number,
): { result: PlayResult } | { reject: string } {
  // Bind the chart to the board: recompute the SAME content hash the client
  // keyed its submission on. A mismatch means the shipped chart isn't the one
  // this board ranks — reject rather than let an easier chart score it.
  const timing = reconstructTiming(chartData.timing);
  const hash = hashChartContent(chartData.stepsType, chartData.noteData, timing);
  if (hash !== expectedChartHash) return { reject: 'chart does not match the board hash' };

  const numTracks = stepsTypeNumTracks(chartData.stepsType) || 4;
  const noteData = parseNoteGrid(chartData.noteData, numTracks, []);
  const judge = new Judge(noteData, timing, DEFAULT_WINDOWS, musicRate);

  // How long to run: past the last note head/tail plus a settle tail.
  let end = 0;
  for (const n of judge.notes) end = Math.max(end, n.time, n.tailTime);
  end += SIM_TAIL_SECONDS;

  // Drive the loop like GameSession: apply every input due by `now` through the
  // same step() path (at the event's own recorded time), tracking held state,
  // then tick update(now, held). Events are already time-sorted.
  const held = new Array<boolean>(numTracks).fill(false);
  let cursor = 0;
  const applyDueEvents = (now: number): void => {
    while (cursor < replay.length && replay[cursor].t <= now) {
      const e = replay[cursor++];
      if (e.track >= 0 && e.track < numTracks) held[e.track] = !e.up;
      judge.step(e.track, e.t, e.up);
    }
  };

  // Fine-step only as far as inputs can matter (bounded); anything a note can be
  // HIT at lives at or before the last recorded input. Notes further out can
  // only be missed, which the coarse flush below ages in one pass.
  const fineEnd = Math.min(end, MAX_FINE_SIM_SECONDS);
  for (let now = 0; now <= fineEnd; now += SIM_STEP_SECONDS) {
    applyDueEvents(now);
    judge.update(now, held);
  }
  // Flush: apply any remaining inputs, then a single update at the true end so
  // every trailing note ages to Miss and every active hold resolves.
  applyDueEvents(end);
  judge.update(end, held);

  return { result: resultOf(judge) };
}
