/**
 * Differential parity: run REAL charts through our engine and an independent
 * from-source ITGmania reference (tests/reference/itgReferenceJudge.ts) with the
 * same generated input traces, and assert identical output note-for-note. Reads
 * charts from an ITGmania Songs folder if present (PARITY_SONGS env or the
 * default install path); skips when absent, so CI is unaffected.
 *
 * This is not the compiled engine — it's a literal transcription of ITGmania's
 * judgment (Player/ScoreKeeperNormal/LifeMeterBar) diffed against ours over real
 * data, to surface any logic divergence (jacks, jumps, holds, rolls, mines).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSimfile } from '../src/parse/loader';
import { Judge } from '../src/gameplay/judge';
import { HoldNoteScore, TapNoteScore, TapNoteType } from '../src/notes/noteTypes';
import { RefJudge } from './reference/itgReferenceJudge';

// Opt-in: point PARITY_SONGS at an ITGmania/StepMania Songs folder to run it.
// Left unset (CI, and the default `npm test`) it skips, so it never slows the
// suite. Run it with:  PARITY_SONGS="C:/Games/ITGmania/Songs" npx vitest run tests/parity.test.ts
const SONGS =
  process.env.PARITY_SONGS && existsSync(process.env.PARITY_SONGS) ? process.env.PARITY_SONGS : '';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Recursively collect simfiles, capped. */
function findSimfiles(root: string, cap: number): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= cap) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (out.length >= cap) return;
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/\.(sm|ssc)$/i.test(e)) out.push(p);
    }
  };
  walk(root);
  return out;
}

type Op =
  | { kind: 'step'; t: number; track: number; release: boolean }
  | { kind: 'update'; t: number; held: boolean[] };

/** A deterministic trace over a chart: presses with a spread of offsets (W1..miss),
 *  holds held (mostly) or dropped, mines mostly avoided, plus 60Hz update ticks. */
function buildTrace(judge: Judge, tracks: number, seed: number): { ops: Op[]; end: number } {
  const rnd = rng(seed);
  const events: Array<{ t: number; track: number; release: boolean }> = [];
  const holdIntervals: Array<{ track: number; a: number; b: number }> = [];
  let end = 0;

  for (const n of judge.notes) {
    end = Math.max(end, n.tailTime + 0.5);
    if (!n.judgable) continue;
    if (n.note.type === TapNoteType.Mine) {
      if (rnd() < 0.15)
        events.push({ t: n.time + (rnd() - 0.5) * 0.1, track: n.track, release: false });
      continue;
    }
    const r = rnd();
    if (r > 0.97) continue; // ~3% missed (no press)
    // ~12% of presses land exactly on a window edge (and one just past W5), so
    // the diff also exercises the inclusive <= boundary with real note times.
    const EDGES = [0.0225, 0.045, 0.09, 0.135, 0.18, 0.18 + 1e-6];
    const mag =
      r > 0.85
        ? EDGES[Math.floor(rnd() * EDGES.length)]
        : r < 0.5
          ? rnd() * 0.0225
          : r < 0.68
            ? 0.0225 + rnd() * 0.0225
            : r < 0.78
              ? 0.045 + rnd() * 0.045
              : 0.09 + rnd() * 0.09;
    const off = (rnd() < 0.5 ? -1 : 1) * mag;
    const press = n.time + off;
    events.push({ t: press, track: n.track, release: false });
    if (n.note.type === TapNoteType.HoldHead) {
      // hold to the tail, or drop early ~15% of the time.
      const drop = rnd() < 0.15;
      const rel = drop ? press + (n.tailTime - press) * (0.2 + rnd() * 0.5) : n.tailTime + 0.05;
      events.push({ t: rel, track: n.track, release: true });
      holdIntervals.push({ track: n.track, a: press, b: rel });
    }
  }

  const heldAt = (t: number): boolean[] => {
    const h = new Array<boolean>(tracks).fill(false);
    for (const iv of holdIntervals) if (t >= iv.a && t < iv.b) h[iv.track] = true;
    return h;
  };

  const ops: Op[] = events.map((e) => ({ kind: 'step' as const, ...e }));
  for (let t = 0; t <= end; t += 1 / 60) ops.push({ kind: 'update', t, held: heldAt(t) });
  ops.push({ kind: 'update', t: end + 1, held: new Array<boolean>(tracks).fill(false) });
  ops.sort((a, b) => a.t - b.t || (a.kind === 'update' ? 1 : -1)); // steps before updates at a tie
  return { ops, end };
}

function run(judge: Judge | RefJudge, ops: Op[]): void {
  for (const op of ops) {
    if (op.kind === 'step') judge.step(op.track, op.t, op.release);
    else judge.update(op.t, op.held);
  }
}

const TNS_NAME: Record<number, string> = {
  [TapNoteScore.None]: 'None',
  [TapNoteScore.HitMine]: 'HitMine',
  [TapNoteScore.AvoidMine]: 'AvoidMine',
  [TapNoteScore.Miss]: 'Miss',
  [TapNoteScore.W5]: 'W5',
  [TapNoteScore.W4]: 'W4',
  [TapNoteScore.W3]: 'W3',
  [TapNoteScore.W2]: 'W2',
  [TapNoteScore.W1]: 'W1',
};
const HNS_NAME = ['None', 'A', 'B', 'Missed']; // our LetGo=1/Held=2; reference Held=1/LetGo=2 — compare by mapped name
const ourHold = (h: HoldNoteScore) =>
  h === HoldNoteScore.Held ? 'Held' : h === HoldNoteScore.LetGo ? 'LetGo' : HNS_NAME[h];
// reference uses its own enum (Held=1, LetGo=2, Missed=3)
const refHold = (h: number) => (h === 1 ? 'Held' : h === 2 ? 'LetGo' : h === 3 ? 'Missed' : 'None');

const maybe = SONGS ? describe : describe.skip;

maybe('parity vs ITGmania reference over real charts', () => {
  it('matches the reference note-for-note across real charts', () => {
    const files = findSimfiles(SONGS, 220);
    expect(files.length).toBeGreaterThan(0);

    let checked = 0;
    let notesChecked = 0;
    const mismatches: string[] = [];

    outer: for (const file of files) {
      let song;
      try {
        song = parseSimfile(readFileSync(file, 'utf8'), file);
      } catch {
        continue; // unparseable / exotic — skip
      }
      for (let ci = 0; ci < song.charts.length; ci++) {
        let nd;
        try {
          nd = song.charts[ci].getNoteData();
        } catch {
          continue;
        }
        if (nd.numTracks !== 4) continue; // dance-single only
        const ours = new Judge(nd, song.timing);
        if (ours.notes.length === 0 || ours.notes.length > 6000) continue;
        const ref = new RefJudge(nd, song.timing);
        const { ops } = buildTrace(ours, nd.numTracks, (checked + 1) * 2654435761);
        run(ours, ops); // ops are deterministic — the same list drives both
        run(ref, ops);

        const tag = `${file.split(/[\\/]/).slice(-1)[0]} #${ci}`;
        if (ours.notes.length !== ref.notes.length)
          mismatches.push(`${tag}: note count ${ours.notes.length} vs ${ref.notes.length}`);
        for (let i = 0; i < Math.min(ours.notes.length, ref.notes.length); i++) {
          notesChecked++;
          const a = ours.notes[i];
          const b = ref.notes[i];
          if (a.tns !== b.tns)
            mismatches.push(`${tag} note ${i}: tns ${TNS_NAME[a.tns]} vs ${TNS_NAME[b.tns]}`);
          if (a.note.type === TapNoteType.HoldHead && ourHold(a.hns) !== refHold(b.hns))
            mismatches.push(`${tag} note ${i}: hold ${ourHold(a.hns)} vs ${refHold(b.hns)}`);
        }
        if (ours.maxCombo !== ref.maxCombo)
          mismatches.push(`${tag}: maxCombo ${ours.maxCombo} vs ${ref.maxCombo}`);
        if (Math.abs(ours.percentDancePoints - ref.percentDancePoints) > 1e-9)
          mismatches.push(`${tag}: % ${ours.percentDancePoints} vs ${ref.percentDancePoints}`);
        if (Math.abs(ours.life - ref.life) > 1e-9)
          mismatches.push(`${tag}: life ${ours.life} vs ${ref.life}`);
        checked++;
        if (mismatches.length > 20) break outer;
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[parity] ${checked} charts, ${notesChecked} notes checked; ${mismatches.length} mismatches`,
    );
    expect({ mismatches: mismatches.slice(0, 20), checked }).toEqual({ mismatches: [], checked });
  }, 120000);
});
