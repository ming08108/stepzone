/**
 * Phase 1 of the RL dance project: batch-convert a StepMania song library into
 * per-chart foot-placement timelines for RL training.
 *
 * Recursively sweeps a Songs directory for .sm/.ssc simfiles, parses each with
 * the game's own parser, runs the StepParity foot-assignment solver on every
 * dance-single chart, and emits one timeline JSON per chart plus an index.json.
 *
 * The heavy lifting is reused wholesale from the engine: parseSimfile (parsing),
 * TimingData (beat->second honoring BPM changes/stops/warps), and
 * computeFootPlacements (StepParity solve). This script only orchestrates the
 * sweep, derives light-weight metadata (bpm range, nps), and writes files.
 *
 *   npx vite-node scripts/extractCharts.ts [songsDir] [outDir]
 *   npm run extract:charts
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseSimfile } from '../src/parse/loader';
import { computeFootPlacements } from '../src/analysis/stepParity';
import { difficultyToString } from '../src/song/difficulty';
import type { NoteData } from '../src/notes/noteData';
import type { TimingData } from '../src/timing/timingData';

const SONGS_DIR = resolve(process.argv[2] ?? 'C:/Games/ITGmania/Songs');
const OUT_DIR = resolve(process.argv[3] ?? 'F:/claude workspace/notefield/data/chart-timelines');

// ---------------------------------------------------------------------------
// Filesystem sweep
// ---------------------------------------------------------------------------

/** All .sm/.ssc files under `root`, recursively (skips hidden/AppleDouble). */
function collectSimfiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue; // hidden / ._resource forks
      const p = join(dir, e);
      let s;
      try {
        s = statSync(p);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(p);
      else if (/\.(ssc|sm)$/i.test(e)) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Pack = the folder directly under the Songs root (e.g. Songs/<pack>/<song>/). */
function packOf(file: string): string {
  const rel = file.slice(SONGS_DIR.length).replace(/\\/g, '/').replace(/^\/+/, '');
  const segs = rel.split('/').filter(Boolean);
  // segs = [pack, song, file.sm] normally; [pack, file.sm] if a song sits
  // directly in a pack folder. First segment is always the pack.
  return segs.length >= 2 ? segs[0] : '(loose)';
}

// ---------------------------------------------------------------------------
// Slug / hashing
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  const base = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base;
}

/** FNV-1a 32-bit, hex — stable across runs/platforms. */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeId(pack: string, title: string, difficulty: string, seed: string): string {
  const p = slugify(pack) || 'pack';
  const t = slugify(title) || 'song';
  const d = slugify(difficulty) || 'diff';
  // Short hash of the fully-qualified seed guarantees uniqueness even when the
  // slug collapses (all-CJK titles) or two charts share pack/title/difficulty.
  const h = hash32(seed).toString(16).padStart(8, '0').slice(0, 6);
  return `${p}__${t}__${d}__${h}`;
}

// ---------------------------------------------------------------------------
// Metadata derivation
// ---------------------------------------------------------------------------

function bpmRange(timing: TimingData): [number, number] {
  const bpms = timing.bpms.map((b) => b.bps * 60).filter((v) => v > 0 && isFinite(v));
  if (bpms.length === 0) return [0, 0];
  return [Math.min(...bpms), Math.max(...bpms)];
}

/** Peak notes-per-second over a 1-second sliding window, from step onset times.
 *  Each note row counts once (a jump is one onset). */
function peakNps(times: number[]): number {
  if (times.length === 0) return 0;
  const t = [...times].sort((a, b) => a - b);
  let peak = 0;
  let lo = 0;
  for (let hi = 0; hi < t.length; hi++) {
    while (t[hi] - t[lo] >= 1) lo++;
    const count = hi - lo + 1; // notes in (t[hi]-1, t[hi]]
    if (count > peak) peak = count;
  }
  return peak;
}

function bucketOf(npsPeak: number): string {
  if (npsPeak < 2) return '<2';
  if (npsPeak < 4) return '2-4';
  if (npsPeak < 6) return '4-6';
  if (npsPeak < 8) return '6-8';
  return '8+';
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StepOut {
  beat: number;
  t: number;
  lCol: number;
  rCol: number;
  jump: boolean;
}

interface ChartMeta {
  id: string;
  title: string;
  pack: string;
  difficulty: string;
  meter: number;
  stepsType: string;
  bpmRange: [number, number];
  durationSec: number;
  npsMean: number;
  npsPeak: number;
}

type IndexEntry = ChartMeta & { holdout: boolean; bucket: string };

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const skips: Record<string, number> = {
  parseFail: 0,
  noteDataFail: 0,
  emptyNoteData: 0,
  parityNull: 0,
};

function extractChart(
  nd: NoteData,
  timing: TimingData,
  stepsType: string,
): { steps: StepOut[]; durationSec: number; npsMean: number; npsPeak: number } | null {
  const placements = computeFootPlacements(nd, timing, stepsType);
  if (placements === null) return null;

  const steps: StepOut[] = [];
  const times: number[] = [];
  for (const p of placements) {
    // computeFootPlacements returns rows already sorted by beat. `t` honors BPM
    // changes / stops / warps via the engine's beat->second conversion.
    const t = timing.getElapsedTimeFromBeat(p.beat);
    const jump = p.lCol >= 0 && p.rCol >= 0;
    steps.push({ beat: p.beat, t, lCol: p.lCol, rCol: p.rCol, jump });
    times.push(t);
  }
  if (steps.length === 0) return null;

  const first = steps[0].t;
  const last = steps[steps.length - 1].t;
  const durationSec = Math.max(0, last - first);
  const npsMean = durationSec > 0 ? steps.length / durationSec : 0;
  const npsPeak = peakNps(times);
  return { steps, durationSec, npsMean, npsPeak };
}

function main(): void {
  console.log(`Scanning ${SONGS_DIR} ...`);
  const files = collectSimfiles(SONGS_DIR);
  console.log(`Found ${files.length} simfiles.\n`);

  // Fresh output dir each run so stale timelines never leak into a training set.
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const index: IndexEntry[] = [];
  const usedIds = new Set<string>();
  const bucketHist: Record<string, number> = { '<2': 0, '2-4': 0, '4-6': 0, '6-8': 0, '8+': 0 };
  let extracted = 0;
  let holdoutCount = 0;
  let processed = 0;

  for (const file of files) {
    processed++;
    if (processed % 250 === 0) {
      console.log(`  ...${processed}/${files.length} files, ${extracted} charts so far`);
    }

    let song;
    try {
      song = parseSimfile(readFileSync(file, 'utf8'), file);
    } catch {
      skips.parseFail++;
      continue;
    }
    const pack = packOf(file);
    const title = song.title || file.split(/[\\/]/).slice(-1)[0];

    for (const chart of song.charts) {
      if (chart.stepsType !== 'dance-single') continue;

      let nd: NoteData;
      try {
        nd = chart.getNoteData();
      } catch {
        skips.noteDataFail++;
        continue;
      }
      if (nd.size === 0) {
        skips.emptyNoteData++;
        continue;
      }

      const timing = chart.getTimingData(song.timing);
      const result = extractChart(nd, timing, chart.stepsType);
      if (result === null) {
        skips.parityNull++;
        continue;
      }

      const diffStr = difficultyToString(chart.difficulty);
      // Seed with a per-chart-unique key (file path + slot + meter + description)
      // so re-runs are stable and distinct edits don't collide.
      const seed = `${file}|${chart.stepsType}|${chart.difficulty}|${chart.meter}|${chart.description}`;
      let id = makeId(pack, title, diffStr, seed);
      // Belt-and-suspenders: if a hash somehow collides, disambiguate.
      let n = 2;
      while (usedIds.has(id)) id = `${makeId(pack, title, diffStr, seed)}-${n++}`;
      usedIds.add(id);

      const meta: ChartMeta = {
        id,
        title,
        pack,
        difficulty: diffStr,
        meter: chart.meter,
        stepsType: chart.stepsType,
        bpmRange: bpmRange(timing),
        durationSec: result.durationSec,
        npsMean: result.npsMean,
        npsPeak: result.npsPeak,
      };

      // ~10% holdout, deterministic on the id hash.
      const holdout = hash32(id) % 10 === 0;
      const bucket = bucketOf(result.npsPeak);
      bucketHist[bucket]++;
      if (holdout) holdoutCount++;

      writeFileSync(join(OUT_DIR, `${id}.json`), JSON.stringify({ ...meta, steps: result.steps }));
      index.push({ ...meta, holdout, bucket });
      extracted++;
    }
  }

  writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2));

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------
  console.log('\n=== extraction summary ===');
  console.log(`files scanned:   ${files.length}`);
  console.log(
    `charts extracted: ${extracted}  (${holdoutCount} holdout, ${extracted - holdoutCount} train)`,
  );
  console.log(`skipped:`);
  console.log(`  parse failure:      ${skips.parseFail}`);
  console.log(`  notedata failure:   ${skips.noteDataFail}`);
  console.log(`  empty notedata:     ${skips.emptyNoteData}`);
  console.log(`  StepParity null:    ${skips.parityNull}`);
  console.log(`bucket histogram (by npsPeak):`);
  for (const b of ['<2', '2-4', '4-6', '6-8', '8+']) {
    console.log(`  ${b.padEnd(4)} ${bucketHist[b]}`);
  }
  console.log(`\nwrote ${extracted} chart files + index.json to ${OUT_DIR}`);
}

main();
