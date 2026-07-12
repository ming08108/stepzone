/**
 * Validation harness: parse real simfiles, run BOTH the TS tech-count port and
 * the compiled ITGmania StepParity ground-truth tool on identical note/timing
 * input, and diff. Not part of the app — a dev tool for matching ITGmania.
 *
 *   npx vite-node scripts/techValidate.ts <gt.exe> <file-or-dir> [maxFiles]
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSimfile } from '../src/parse/loader';
import { computeChartStats } from '../src/analysis/chartStats';
import { noteRowToBeat, TapNoteType } from '../src/notes/noteTypes';
import type { NoteData } from '../src/notes/noteData';
import type { TimingData } from '../src/timing/timingData';

const gtExe = process.argv[2];
const target = process.argv[3];
const maxFiles = Number(process.argv[4] ?? '80');

const TYPE_CODE: Record<string, number> = { 'dance-single': 0, 'dance-double': 1 };

function buildInput(nd: NoteData, timing: TimingData, typeCode: number): string {
  const lines: string[] = [`T ${nd.numTracks} ${typeCode}`];
  const rows = new Set<number>();
  for (let c = 0; c < nd.numTracks; c++) {
    for (const { row, note } of nd.getTrack(c)) {
      const dur = note.type === TapNoteType.HoldHead ? note.durationRows : 0;
      lines.push(`N ${row} ${c} ${note.type} ${note.subType} ${dur}`);
      rows.add(row);
    }
  }
  for (const row of rows) {
    const sec = timing.getElapsedTimeFromBeat(noteRowToBeat(row));
    const fake = timing.isFakeAtRow(row) ? 1 : 0;
    // Full precision: C++ parses to float32; the TS solver frounds the same
    // double, so both consume identical float seconds.
    lines.push(`S ${row} ${sec} ${fake} 0`);
  }
  lines.push('E');
  return lines.join('\n') + '\n';
}

function groundTruth(input: string): Record<string, number> {
  const out = execFileSync(gtExe, { input, encoding: 'utf8' }).trim();
  const rec: Record<string, number> = {};
  for (const kv of out.split(/\s+/)) {
    const [k, v] = kv.split('=');
    if (k && v !== undefined) rec[k] = Number(v);
  }
  return rec;
}

function collectFiles(t: string): string[] {
  const st = statSync(t);
  if (st.isFile()) return [t];
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (/\.(ssc|sm)$/i.test(e)) out.push(p);
    }
  };
  walk(t);
  return out;
}

let charts = 0;
let matched = 0;
const mismatches: string[] = [];

const files = collectFiles(target).slice(0, maxFiles);
for (const file of files) {
  let song;
  try {
    song = parseSimfile(readFileSync(file, 'utf8'), file);
  } catch {
    continue;
  }
  for (const chart of song.charts) {
    const code = TYPE_CODE[chart.stepsType];
    if (code === undefined) continue;
    let nd: NoteData;
    try {
      nd = chart.getNoteData();
    } catch {
      continue;
    }
    if (nd.size === 0) continue;
    const timing = chart.getTimingData(song.timing);
    const input = buildInput(nd, timing, code);
    const gt = groundTruth(input);
    const ts = computeChartStats(nd, timing, chart.stepsType).tech!;
    charts++;
    const ok =
      gt.cross === ts.crossovers &&
      gt.foot === ts.footswitches &&
      gt.side === ts.sideswitches &&
      gt.jack === ts.jacks &&
      gt.brack === ts.brackets;
    if (ok) matched++;
    else {
      if (process.env.DUMP) {
        writeFileSync(process.env.DUMP, input);
        process.env.DUMP = ''; // first mismatch only
      }
      const name = `${file.split(/[\\/]/).slice(-1)[0]} [${chart.stepsType} ${chart.difficulty} m${chart.meter}]`;
      mismatches.push(
        `${name}\n  GT: X=${gt.cross} F=${gt.foot} S=${gt.side} J=${gt.jack} B=${gt.brack}\n  TS: X=${ts.crossovers} F=${ts.footswitches} S=${ts.sideswitches} J=${ts.jacks} B=${ts.brackets}`,
      );
    }
  }
}

console.log(
  `\ncharts: ${charts}  matched: ${matched}  (${((100 * matched) / Math.max(1, charts)).toFixed(1)}%)`,
);
if (mismatches.length) {
  console.log(`\n--- mismatches (${mismatches.length}) ---`);
  for (const m of mismatches.slice(0, 40)) console.log(m);
}
