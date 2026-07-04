/**
 * `.sm` negative-BPM / negative-stop → warp conversion.
 *
 * A faithful port of ITGmania `SMLoader::ProcessBPMsAndStops`
 * (NotesLoaderSM.cpp:503-696). See spec doc 2 §2.5. Runtime timing has no
 * concept of negative BPMs; SM-authored negatives (and "infinite" > 9999999
 * BPMs, and negative stops) become explicit warps + positive BPMs/stops.
 */

import { beatToNoteRow } from '../notes/noteTypes';
import type { BpmSegment, StopSegment, WarpSegment } from '../timing/segments';
import { parsePairs } from './timingTags';

export const FAST_BPM_WARP = 9999999;

export interface ProcessedTiming {
  bpms: BpmSegment[];
  stops: StopSegment[];
  warps: WarpSegment[];
  /** Seconds to add to the song offset (from pre-beat-0 stops). */
  offsetDelta: number;
}

/** Parse a `beat=value` list into [beat, value] pairs, keeping negatives, dropping 0. */
export function rawPairs(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const { beat, values } of parsePairs(s)) {
    const v = values[0];
    if (Number.isFinite(v) && v !== 0) out.push([beat, v]);
  }
  return out;
}

export function processBpmsAndStops(
  vBPMs: Array<[number, number]>,
  vStops: Array<[number, number]>,
): ProcessedTiming {
  const bpms: BpmSegment[] = [];
  const stops: StopSegment[] = [];
  const warps: WarpSegment[] = [];
  let offsetDelta = 0;

  const addBpm = (beat: number, bpm: number) =>
    bpms.push({ row: beatToNoteRow(beat), bps: bpm / 60 });
  const addStop = (beat: number, sec: number) =>
    stops.push({ row: beatToNoteRow(beat), seconds: sec });
  const addWarp = (beat: number, lengthBeats: number) =>
    warps.push({ row: beatToNoteRow(beat), lengthRows: beatToNoteRow(lengthBeats) });

  const bpmList = [...vBPMs].sort((a, b) => a[0] - b[0]);
  const stopList = [...vStops].sort((a, b) => a[0] - b[0]);

  let bpm = 0;
  let prevbeat = 0;
  let warpstart = -1;
  let prewarpbpm = 0;
  let timeofs = 0;
  let ib = 0;
  let is = 0;

  // Pre-beat-0 stops fold into the offset.
  while (is < stopList.length && stopList[is][0] < 0) {
    offsetDelta -= stopList[is][1];
    is++;
  }
  // Consume pre/at-0 BPMs; keep the last as the initial BPM.
  while (ib < bpmList.length && bpmList[ib][0] <= 0) {
    bpm = bpmList[ib][1];
    ib++;
  }
  if (bpm === 0) {
    if (ib >= bpmList.length) bpm = 60;
    else {
      bpm = bpmList[ib][1];
      ib++;
    }
  }
  if (bpm > 0 && bpm <= FAST_BPM_WARP) addBpm(0, bpm);

  while (ib < bpmList.length || is < stopList.length) {
    const changeIsBpm =
      is >= stopList.length || (ib < bpmList.length && bpmList[ib][0] <= stopList[is][0]);
    const change = changeIsBpm ? bpmList[ib] : stopList[is];
    const cbeat = change[0];
    const cval = change[1];

    if (bpm <= FAST_BPM_WARP) {
      timeofs += ((cbeat - prevbeat) * 60) / bpm;
      if (warpstart >= 0 && bpm > 0 && timeofs > 0) {
        const warpend = cbeat - (timeofs * bpm) / 60;
        addWarp(warpstart, warpend - warpstart);
        if (bpm !== prewarpbpm) addBpm(warpstart, bpm);
        warpstart = -1;
      }
    }

    prevbeat = cbeat;

    if (changeIsBpm) {
      if (warpstart < 0 && (cval < 0 || cval > FAST_BPM_WARP)) {
        warpstart = cbeat;
        prewarpbpm = bpm;
        timeofs = 0;
      } else if (warpstart < 0) {
        addBpm(cbeat, cval);
      }
      bpm = cval;
      ib++;
    } else {
      if (warpstart < 0 && cval < 0) {
        warpstart = cbeat;
        prewarpbpm = bpm;
        timeofs = cval;
      } else if (warpstart < 0) {
        addStop(cbeat, cval);
      } else {
        timeofs += cval;
        if (cval > 0 && timeofs > 0) {
          addWarp(warpstart, cbeat - warpstart);
          addStop(cbeat, timeofs);
          if (bpm < 0 || bpm > FAST_BPM_WARP) {
            warpstart = cbeat;
            timeofs = 0;
          } else {
            if (bpm !== prewarpbpm) addBpm(warpstart, bpm);
            warpstart = -1;
          }
        }
      }
      is++;
    }
  }

  if (warpstart >= 0) {
    const warpend = bpm < 0 || bpm > FAST_BPM_WARP ? 99999999 : prevbeat - (timeofs * bpm) / 60;
    addWarp(warpstart, warpend - warpstart);
    if (bpm !== prewarpbpm) addBpm(warpstart, bpm);
  }

  return { bpms, stops, warps, offsetDelta };
}
