/**
 * Beat <-> second conversion, the mathematical heart of the player.
 *
 * A faithful port of ITGmania's `TimingData::GetElapsedTimeInternal` /
 * `GetBeatInternal` (src/TimingData.cpp). See spec doc 2. Unlike the engine we
 * do not (yet) build the lookup-table cache — every query walks the segment
 * lists from row 0. Correct first; optimize when profiling says so.
 *
 * Offsets: this class applies only the song `#OFFSET`. The runtime global
 * offset and music-rate scaling live in the audio/clock layer (spec doc 6),
 * matching the engine's "...NoOffset" functions.
 */

import { beatToNoteRow, noteRowToBeat } from '../notes/noteTypes';
import {
  type BpmSegment,
  type ComboSegment,
  type DelaySegment,
  type FakeSegment,
  type LabelSegment,
  type ScrollSegment,
  type SpeedSegment,
  type StopSegment,
  type TickcountSegment,
  type TimeSignatureSegment,
  type WarpSegment,
  sortByRow,
} from './segments';

/** Result of a time -> beat lookup. */
export interface BeatInfo {
  beat: number;
  /** Beats per second in effect. */
  bps: number;
  /** True if the position is inside a STOP. */
  freeze: boolean;
  /** True if the position is inside a DELAY. */
  delay: boolean;
  /** Row where the active warp began, or -1. */
  warpBeginRow: number;
  /** Destination beat of the active warp. */
  warpDestination: number;
}

const enum EventType {
  WarpDestination,
  BpmChange,
  Delay,
  Marker,
  Stop,
  Warp,
  NotFound,
}

interface Cursor {
  bpm: number;
  warp: number;
  stop: number;
  delay: number;
  lastRow: number;
  lastTime: number;
  warpDestination: number;
  isWarping: boolean;
  warpBeginRow: number;
}

const DEFAULT_BPS = 60 / 60; // 60 BPM

export class TimingData {
  /** Seconds between the start of the audio and musical beat 0 (the `#OFFSET`). */
  offsetSeconds = 0;

  // Consumed by beat<->time conversion (bpms/stops/delays/warps) and
  // judgability (warps/fakes).
  bpms: BpmSegment[] = [];
  stops: StopSegment[] = [];
  delays: DelaySegment[] = [];
  warps: WarpSegment[] = [];
  fakes: FakeSegment[] = [];

  // Parsed and carried, but not yet consumed by anything (timing math,
  // judging, or rendering). Kept for future features — do not delete.
  scrolls: ScrollSegment[] = [];
  speeds: SpeedSegment[] = [];
  timeSignatures: TimeSignatureSegment[] = [];
  tickcounts: TickcountSegment[] = [];
  combos: ComboSegment[] = [];
  labels: LabelSegment[] = [];

  /**
   * Copy this timing: offset copied, every segment array copied (segment
   * objects shared — treat them as immutable). Arrays are discovered
   * dynamically so a newly added segment list can never be silently dropped.
   */
  clone(): TimingData {
    const t = new TimingData();
    t.offsetSeconds = this.offsetSeconds;
    for (const key of Object.keys(this)) {
      const v = (this as Record<string, unknown>)[key];
      if (Array.isArray(v)) (t as unknown as Record<string, unknown>)[key] = [...v];
    }
    return t;
  }

  /** Sort every list by row and guarantee a BPM at row 0 (default 60). */
  tidy(): void {
    sortByRow(this.bpms);
    sortByRow(this.stops);
    sortByRow(this.delays);
    sortByRow(this.warps);
    sortByRow(this.scrolls);
    sortByRow(this.speeds);
    sortByRow(this.timeSignatures);
    sortByRow(this.tickcounts);
    sortByRow(this.combos);
    sortByRow(this.labels);
    sortByRow(this.fakes);
    if (this.bpms.length === 0 || this.bpms[0].row !== 0) {
      this.bpms.unshift({ row: 0, bps: DEFAULT_BPS });
    }
  }

  /** BPS in effect at a row (last segment whose row <= the query). */
  getBpsAtRow(row: number): number {
    let bps = this.bpms.length > 0 ? this.bpms[0].bps : DEFAULT_BPS;
    for (const b of this.bpms) {
      if (b.row <= row) bps = b.bps;
      else break;
    }
    return bps;
  }

  /** BPM at a row. Unused by the engine itself; kept as a trivial convenience. */
  getBpmAtRow(row: number): number {
    return this.getBpsAtRow(row) * 60;
  }

  // --- The event scanner (ITGmania FindEvent) ------------------------------
  // Ties are broken by check order (strict `< eventRow`), which is what gives
  // DELAY-before-notes and STOP-after-notes their semantics. Do not reorder.

  private findEvent(
    c: Cursor,
    beat: number,
    findMarker: boolean,
  ): { row: number; type: EventType } {
    let eventRow = Number.MAX_SAFE_INTEGER;
    let eventType = EventType.NotFound;

    if (c.isWarping && beatToNoteRow(c.warpDestination) < eventRow) {
      eventRow = beatToNoteRow(c.warpDestination);
      eventType = EventType.WarpDestination;
    }
    if (c.bpm < this.bpms.length && this.bpms[c.bpm].row < eventRow) {
      eventRow = this.bpms[c.bpm].row;
      eventType = EventType.BpmChange;
    }
    if (c.delay < this.delays.length && this.delays[c.delay].row < eventRow) {
      eventRow = this.delays[c.delay].row;
      eventType = EventType.Delay;
    }
    if (findMarker && beatToNoteRow(beat) < eventRow) {
      eventRow = beatToNoteRow(beat);
      eventType = EventType.Marker;
    }
    if (c.stop < this.stops.length && this.stops[c.stop].row < eventRow) {
      eventRow = this.stops[c.stop].row;
      eventType = EventType.Stop;
    }
    if (c.warp < this.warps.length && this.warps[c.warp].row < eventRow) {
      eventRow = this.warps[c.warp].row;
      eventType = EventType.Warp;
    }
    return { row: eventRow, type: eventType };
  }

  private newCursor(): Cursor {
    return {
      bpm: 0,
      warp: 0,
      stop: 0,
      delay: 0,
      lastRow: 0,
      lastTime: 0,
      warpDestination: 0,
      isWarping: false,
      warpBeginRow: -1,
    };
  }

  /**
   * Enter the warp at cursor index `c.warp`: start warping, extend the warp
   * destination if this warp reaches further, and advance the index. Shared
   * by both conversion loops; the event-order semantics live in findEvent.
   */
  private advanceWarp(c: Cursor): void {
    c.isWarping = true;
    const ws = this.warps[c.warp];
    const warpSum = noteRowToBeat(ws.lengthRows) + noteRowToBeat(ws.row);
    if (warpSum > c.warpDestination) c.warpDestination = warpSum;
    c.warp++;
  }

  // --- beat -> time (ITGmania GetElapsedTimeInternal) ----------------------

  private elapsedTimeInternal(c: Cursor, beat: number): number {
    let bps = this.getBpsAtRow(c.lastRow);
    for (;;) {
      const ev = this.findEvent(c, beat, true);
      const timeToNext = c.isWarping ? 0 : noteRowToBeat(ev.row - c.lastRow) / bps;
      c.lastTime += timeToNext;
      switch (ev.type) {
        case EventType.WarpDestination:
          c.isWarping = false;
          break;
        case EventType.BpmChange:
          bps = this.bpms[c.bpm].bps;
          c.bpm++;
          break;
        case EventType.Stop:
          c.lastTime += this.stops[c.stop].seconds;
          c.stop++;
          break;
        case EventType.Delay:
          c.lastTime += this.delays[c.delay].seconds;
          c.delay++;
          break;
        case EventType.Marker:
          return c.lastTime;
        case EventType.Warp:
          this.advanceWarp(c);
          break;
        case EventType.NotFound:
          // Unreachable for beat->time: the marker always fires first.
          return c.lastTime;
      }
      c.lastRow = ev.row;
    }
  }

  /** Elapsed audio seconds at a beat (song `#OFFSET` applied). */
  getElapsedTimeFromBeat(beat: number): number {
    const c = this.newCursor();
    return this.elapsedTimeInternal(c, beat) - this.offsetSeconds;
  }

  // --- time -> beat (ITGmania GetBeatInternal) -----------------------------

  private beatInternal(c: Cursor, elapsedTime: number): BeatInfo {
    let bps = this.getBpsAtRow(c.lastRow);
    let warpBeginRow = c.warpBeginRow;
    let warpDestination = c.warpDestination;

    for (;;) {
      const ev = this.findEvent(c, 0, false);
      if (ev.type === EventType.NotFound) break;
      const timeToNext = c.isWarping ? 0 : noteRowToBeat(ev.row - c.lastRow) / bps;
      const nextEventTime = c.lastTime + timeToNext;
      if (elapsedTime < nextEventTime) break;
      c.lastTime = nextEventTime;

      switch (ev.type) {
        case EventType.WarpDestination:
          c.isWarping = false;
          break;
        case EventType.BpmChange:
          bps = this.bpms[c.bpm].bps;
          c.bpm++;
          break;
        case EventType.Delay: {
          const d = this.delays[c.delay];
          const endTime = c.lastTime + d.seconds;
          if (elapsedTime < endTime) {
            return {
              beat: noteRowToBeat(d.row),
              bps,
              freeze: false,
              delay: true,
              warpBeginRow,
              warpDestination,
            };
          }
          c.lastTime = endTime;
          c.delay++;
          break;
        }
        case EventType.Stop: {
          const s = this.stops[c.stop];
          const endTime = c.lastTime + s.seconds;
          if (elapsedTime < endTime) {
            return {
              beat: noteRowToBeat(s.row),
              bps,
              freeze: true,
              delay: false,
              warpBeginRow,
              warpDestination,
            };
          }
          c.lastTime = endTime;
          c.stop++;
          break;
        }
        case EventType.Warp:
          this.advanceWarp(c);
          warpBeginRow = ev.row;
          warpDestination = c.warpDestination;
          break;
        case EventType.Marker:
          break; // not used in time->beat
      }
      c.lastRow = ev.row;
    }

    return {
      beat: noteRowToBeat(c.lastRow) + (elapsedTime - c.lastTime) * bps,
      bps,
      freeze: false,
      delay: false,
      warpBeginRow,
      warpDestination,
    };
  }

  /** Full beat info at an audio position (song `#OFFSET` applied). */
  getBeatInfoFromElapsedTime(seconds: number): BeatInfo {
    const c = this.newCursor();
    return this.beatInternal(c, seconds + this.offsetSeconds);
  }

  /** Musical beat at an audio position. */
  getBeatFromElapsedTime(seconds: number): number {
    return this.getBeatInfoFromElapsedTime(seconds).beat;
  }

  // --- Warp / fake / judgability -------------------------------------------

  /** Is this row skipped by a warp (and thus unhittable)? */
  isWarpAtRow(row: number): boolean {
    const beat = noteRowToBeat(row);
    for (const w of this.warps) {
      const start = noteRowToBeat(w.row);
      const end = start + noteRowToBeat(w.lengthRows);
      if (start <= beat && beat < end) {
        // A stop/delay landing exactly on this row "punches through" the warp.
        if (this.stops.length === 0 && this.delays.length === 0) return true;
        if (this.getStopAtRow(row) !== 0 || this.getDelayAtRow(row) !== 0) return false;
        return true;
      }
    }
    return false;
  }

  /** Is this row inside a fake region (drawn but unjudgable)? */
  isFakeAtRow(row: number): boolean {
    const beat = noteRowToBeat(row);
    for (const f of this.fakes) {
      const start = noteRowToBeat(f.row);
      const end = start + noteRowToBeat(f.lengthRows);
      if (start <= beat && beat < end) return true;
    }
    return false;
  }

  /** A note at this row can be scored only if it is neither warped nor faked. */
  isJudgableAtRow(row: number): boolean {
    return !this.isWarpAtRow(row) && !this.isFakeAtRow(row);
  }

  getStopAtRow(row: number): number {
    for (const s of this.stops) if (s.row === row) return s.seconds;
    return 0;
  }

  getDelayAtRow(row: number): number {
    for (const d of this.delays) if (d.row === row) return d.seconds;
    return 0;
  }
}
