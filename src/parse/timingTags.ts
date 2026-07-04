/**
 * Helpers for the `beat=value[,...]` timing-tag grammar shared by `.sm`/`.ssc`.
 * See spec doc 1 (§1.6).
 */

import { beatToNoteRow } from '../notes/noteTypes';
import type {
  BpmSegment,
  DelaySegment,
  FakeSegment,
  ScrollSegment,
  SpeedSegment,
  StopSegment,
  WarpSegment,
} from '../timing/segments';
import { TimingData } from '../timing/timingData';

/** `.ssc` version at which per-chart timing became authoritative and warps relative. */
export const VERSION_SPLIT_TIMING = 0.7;

export interface Pair {
  beat: number;
  values: number[];
}

/** Parse a `beat=v1=v2,beat=v1,...` list into pairs, dropping malformed entries. */
export function parsePairs(s: string): Pair[] {
  const out: Pair[] = [];
  for (const chunk of s.split(',')) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;
    const parts = trimmed.split('=');
    if (parts.length < 2) continue;
    const beat = Number.parseFloat(parts[0]);
    if (Number.isNaN(beat)) continue;
    const values = parts.slice(1).map((v) => Number.parseFloat(v));
    out.push({ beat, values });
  }
  return out;
}

export function parseBpms(s: string): BpmSegment[] {
  const out: BpmSegment[] = [];
  for (const { beat, values } of parsePairs(s)) {
    const bpm = values[0];
    // Reject non-positive BPMs (SSC). Negative-BPM->warp for `.sm` is handled
    // separately (see sm.ts); not yet implemented.
    if (beat < 0 || !Number.isFinite(bpm) || bpm <= 0) continue;
    out.push({ row: beatToNoteRow(beat), bps: bpm / 60 });
  }
  return out;
}

export function parseStops(s: string): StopSegment[] {
  const out: StopSegment[] = [];
  for (const { beat, values } of parsePairs(s)) {
    const seconds = values[0];
    if (beat < 0 || !Number.isFinite(seconds) || seconds === 0) continue;
    out.push({ row: beatToNoteRow(beat), seconds });
  }
  return out;
}

export function parseDelays(s: string): DelaySegment[] {
  const out: DelaySegment[] = [];
  for (const { beat, values } of parsePairs(s)) {
    const seconds = values[0];
    if (beat < 0 || !Number.isFinite(seconds) || seconds <= 0) continue;
    out.push({ row: beatToNoteRow(beat), seconds });
  }
  return out;
}

export function parseWarps(s: string, version: number): WarpSegment[] {
  const out: WarpSegment[] = [];
  for (const { beat, values } of parsePairs(s)) {
    const v = values[0];
    if (beat < 0 || !Number.isFinite(v)) continue;
    let lengthBeats: number;
    if (version !== 0 && version < VERSION_SPLIT_TIMING && v > beat) {
      lengthBeats = v - beat; // legacy: absolute destination beat
    } else if (v > 0) {
      lengthBeats = v; // modern: relative length
    } else {
      continue;
    }
    out.push({ row: beatToNoteRow(beat), lengthRows: beatToNoteRow(lengthBeats) });
  }
  return out;
}

export function parseScrolls(s: string): ScrollSegment[] {
  const out: ScrollSegment[] = [];
  for (const { beat, values } of parsePairs(s)) {
    if (beat < 0 || !Number.isFinite(values[0])) continue;
    out.push({ row: beatToNoteRow(beat), ratio: values[0] });
  }
  return out;
}

export function parseSpeeds(s: string): SpeedSegment[] {
  const out: SpeedSegment[] = [];
  for (const { beat, values } of parsePairs(s)) {
    if (beat < 0 || !Number.isFinite(values[0])) continue;
    const ratio = values[0];
    const delay = Number.isFinite(values[1]) ? values[1] : 0;
    const unit = values[2] === 1 ? 'seconds' : 'beats';
    out.push({ row: beatToNoteRow(beat), ratio, delay, unit });
  }
  return out;
}

export function parseFakes(s: string): FakeSegment[] {
  const out: FakeSegment[] = [];
  for (const { beat, values } of parsePairs(s)) {
    const lengthBeats = values[0];
    if (beat < 0 || !Number.isFinite(lengthBeats) || lengthBeats <= 0) continue;
    out.push({ row: beatToNoteRow(beat), lengthRows: beatToNoteRow(lengthBeats) });
  }
  return out;
}

/** `HH:MM:SS` (or plain seconds) -> seconds. */
export function hhmmssToSeconds(s: string): number {
  const parts = s.split(':').map((p) => Number.parseFloat(p));
  if (parts.some((p) => Number.isNaN(p))) return 0;
  let seconds = 0;
  for (const p of parts) seconds = seconds * 60 + p;
  return seconds;
}

/** Shallow copy of a TimingData (segment arrays copied; segments shared). */
export function cloneTiming(src: TimingData): TimingData {
  const t = new TimingData();
  t.offsetSeconds = src.offsetSeconds;
  t.bpms = [...src.bpms];
  t.stops = [...src.stops];
  t.delays = [...src.delays];
  t.warps = [...src.warps];
  t.scrolls = [...src.scrolls];
  t.speeds = [...src.speeds];
  t.timeSignatures = [...src.timeSignatures];
  t.tickcounts = [...src.tickcounts];
  t.combos = [...src.combos];
  t.labels = [...src.labels];
  t.fakes = [...src.fakes];
  return t;
}
