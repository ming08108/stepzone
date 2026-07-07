/**
 * Replay parity: feed ITGmania's OWN recorded per-note offsets (from a V1
 * replay) through our engine and assert we assign the same TapNoteScore it did.
 * This is the real-engine oracle the from-source differential can't be — the
 * offsets and judgments come from the compiled ITGmania, not a transcription.
 *
 * The fixture test always runs: it proves the parser reads ITGmania's exact
 * TapNote/TapNoteResult serialization and that our reconstruction (press =
 * noteTime - offset) reproduces the recorded scores. Point REPLAY_XML + a chart
 * at REPLAY_CHART to validate against a real replay:
 *   REPLAY_XML=".../Save/Replays/replay00000.xml" REPLAY_CHART=".../song.sm" \
 *     npx vitest run tests/replayParity.test.ts
 * Scope note: V1 replays store only tap results (offset + TNS) — hold Held/LetGo
 * is not recorded, so this checks tap/hold-head judgments, not hold bodies.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';
import { Judge } from '../src/gameplay/judge';
import type { NoteData } from '../src/notes/noteData';
import type { TimingData } from '../src/timing/timingData';
import {
  NO_KEYSOUND,
  NO_PLAYER,
  TapNoteScore,
  TapNoteSubType,
  TapNoteType,
} from '../src/notes/noteTypes';
import { NoteData as NoteDataCtor } from '../src/notes/noteData';
import { TimingData as TimingDataCtor } from '../src/timing/timingData';
import { parseReplayXml, type ReplayNote } from './reference/replay';

/** Drive our engine with the replay's offsets; return per-note score mismatches. */
function scoreMismatches(nd: NoteData, timing: TimingData, replay: ReplayNote[]): string[] {
  const judge = new Judge(nd, timing);
  const byKey = new Map<string, (typeof judge.notes)[number]>();
  for (const n of judge.notes) byKey.set(`${n.track}:${n.row}`, n);

  const steps: Array<{ t: number; track: number }> = [];
  let end = 0;
  for (const r of replay) {
    const our = byKey.get(`${r.track}:${r.row}`);
    if (!our) continue;
    end = Math.max(end, our.time + 0.5);
    // A recorded hit (W1..W5, or a hit mine) → press at noteTime - offset;
    // a Miss / avoided mine had no press, so we let it age out.
    if (r.tns >= TapNoteScore.W5 || r.tns === TapNoteScore.HitMine)
      steps.push({ t: our.time - r.offset, track: r.track });
  }
  steps.sort((a, b) => a.t - b.t);

  let si = 0;
  for (let t = 0; t <= end + 1; t += 1 / 60) {
    while (si < steps.length && steps[si].t <= t) {
      judge.step(steps[si].track, steps[si].t, false);
      si++;
    }
    judge.update(t, []);
  }

  const out: string[] = [];
  for (const r of replay) {
    const our = byKey.get(`${r.track}:${r.row}`);
    if (our && our.tns !== r.tns)
      out.push(`${r.track}:${r.row} ours=${our.tns} replay=${r.tns} (off ${r.offset})`);
  }
  return out;
}

// A hand-authored fixture, byte-faithful to ITGmania's TapNote/TapNoteResult
// output. Offsets map (by |offset|) to the scores ITGmania would assign:
// 10ms→W1, 35ms→W2, 70ms→W3, and an un-hit Miss.
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<ReplayData Version="0">
  <NoteData>
    <TapNote Track="0" Row="0"><TapNoteResult TapNoteScore="W1" TapNoteOffset="0.010000"/><HoldNoteResult/></TapNote>
    <TapNote Track="1" Row="48"><TapNoteResult TapNoteScore="W2" TapNoteOffset="-0.035000"/><HoldNoteResult/></TapNote>
    <TapNote Track="2" Row="96"><TapNoteResult TapNoteScore="W3" TapNoteOffset="0.070000"/><HoldNoteResult/></TapNote>
    <TapNote Track="3" Row="144"><TapNoteResult TapNoteScore="Miss" TapNoteOffset="0.000000"/><HoldNoteResult/></TapNote>
  </NoteData>
</ReplayData>`;

function tap() {
  return {
    type: TapNoteType.Tap,
    subType: TapNoteSubType.Invalid,
    durationRows: 0,
    keysoundIndex: NO_KEYSOUND,
    player: NO_PLAYER,
  };
}

describe('replay parser (V1) — fixture mechanics', () => {
  const notes = parseReplayXml(FIXTURE);

  it('parses track/row/score/offset from the nested TapNoteResult', () => {
    expect(notes).toEqual([
      { track: 0, row: 0, tns: TapNoteScore.W1, offset: 0.01 },
      { track: 1, row: 48, tns: TapNoteScore.W2, offset: -0.035 },
      { track: 2, row: 96, tns: TapNoteScore.W3, offset: 0.07 },
      { track: 3, row: 144, tns: TapNoteScore.Miss, offset: 0 },
    ]);
  });

  it('our engine reproduces the recorded scores from the offsets', () => {
    const nd = new NoteDataCtor(4);
    for (const n of notes) nd.setTapNote(n.track, n.row, tap());
    const timing = new TimingDataCtor();
    timing.bpms.push({ row: 0, bps: 1 }); // 60 BPM → row/48 beats == seconds
    timing.tidy();
    expect(scoreMismatches(nd, timing, notes)).toEqual([]);
  });
});

const XML = process.env.REPLAY_XML;
const CHART = process.env.REPLAY_CHART;
const real = XML && CHART && existsSync(XML) && existsSync(CHART) ? describe : describe.skip;

real('replay parity — real ITGmania replay', () => {
  it('assigns the same tap scores ITGmania recorded', () => {
    const replay = parseReplayXml(readFileSync(XML as string, 'utf8'));
    expect(replay.length).toBeGreaterThan(0);
    const song = parseSimfile(readFileSync(CHART as string, 'utf8'), CHART as string);
    const idx = Number(process.env.REPLAY_CHART_INDEX ?? '');
    const chart = Number.isFinite(idx)
      ? song.charts[idx]
      : (song.charts.find((c) => c.getNoteData().numTracks === 4) ?? song.charts[0]);
    const nd = chart.getNoteData();
    const mismatches = scoreMismatches(nd, song.timing, replay);
    // eslint-disable-next-line no-console
    console.log(`[replay] ${replay.length} notes; ${mismatches.length} score mismatches`);
    expect(mismatches.slice(0, 20)).toEqual([]);
  });
});
