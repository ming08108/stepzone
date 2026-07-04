/**
 * Core note vocabulary and the fixed-point beat/row math.
 *
 * Mirrors ITGmania `src/NoteTypes.h`. See spec doc 3 (§3.1–3.4) in
 * ../itgmania/Docs/TrackPlayerSpec/03-note-data-model.md.
 */

// --- Fixed-point time base -------------------------------------------------

/** Rows per beat. 48 is divisible by 2, 3, 4 so 8th/12th/16th land on integers. */
export const ROWS_PER_BEAT = 48;
/** A 4/4 measure is hard-coded to 4 beats throughout the format. */
export const BEATS_PER_MEASURE = 4;
/** 4 beats * 48 rows = 192 rows per measure. */
export const ROWS_PER_MEASURE = ROWS_PER_BEAT * BEATS_PER_MEASURE;
/** Upper bound for a chart row; also the sentinel for an unclamped hold head. */
export const MAX_NOTE_ROW = 1 << 30;
/** Hard cap on columns (dance-double = 8, techno-double8 = 16). */
export const MAX_NOTE_TRACKS = 16;

/** Beat -> row, rounding to the nearest 1/48 (the standard snap). */
export function beatToNoteRow(beat: number): number {
  return Math.round(beat * ROWS_PER_BEAT);
}

/** Beat -> row, truncating instead of rounding. */
export function beatToNoteRowNotRounded(beat: number): number {
  return Math.trunc(beat * ROWS_PER_BEAT);
}

/** Row -> beat (exact). */
export function noteRowToBeat(row: number): number {
  return row / ROWS_PER_BEAT;
}

// --- Quantization classes (note colors) ------------------------------------

/** How a row divides the beat, used to pick a note's color. */
export enum NoteType {
  N4TH,
  N8TH,
  N12TH,
  N16TH,
  N24TH,
  N32ND,
  N48TH,
  N64TH,
  N192ND,
}

/** Row spacing for a quantization class (e.g. 8th = 24 rows). */
export function noteTypeToRow(nt: NoteType): number {
  switch (nt) {
    case NoteType.N4TH:
      return ROWS_PER_MEASURE / 4; // 48
    case NoteType.N8TH:
      return ROWS_PER_MEASURE / 8; // 24
    case NoteType.N12TH:
      return ROWS_PER_MEASURE / 12; // 16
    case NoteType.N16TH:
      return ROWS_PER_MEASURE / 16; // 12
    case NoteType.N24TH:
      return ROWS_PER_MEASURE / 24; // 8
    case NoteType.N32ND:
      return ROWS_PER_MEASURE / 32; // 6
    case NoteType.N48TH:
      return ROWS_PER_MEASURE / 48; // 4
    case NoteType.N64TH:
      return ROWS_PER_MEASURE / 64; // 3
    case NoteType.N192ND:
      return 1;
  }
}

/**
 * Classify a row into the coarsest quantization it belongs to.
 * This is what a renderer uses to color the arrow.
 */
export function getNoteType(row: number): NoteType {
  if (row % (ROWS_PER_MEASURE / 4) === 0) return NoteType.N4TH;
  if (row % (ROWS_PER_MEASURE / 8) === 0) return NoteType.N8TH;
  if (row % (ROWS_PER_MEASURE / 12) === 0) return NoteType.N12TH;
  if (row % (ROWS_PER_MEASURE / 16) === 0) return NoteType.N16TH;
  if (row % (ROWS_PER_MEASURE / 24) === 0) return NoteType.N24TH;
  if (row % (ROWS_PER_MEASURE / 32) === 0) return NoteType.N32ND;
  if (row % (ROWS_PER_MEASURE / 48) === 0) return NoteType.N48TH;
  if (row % (ROWS_PER_MEASURE / 64) === 0) return NoteType.N64TH;
  return NoteType.N192ND;
}

export function beatToNoteType(beat: number): NoteType {
  return getNoteType(beatToNoteRow(beat));
}

// --- Tap notes -------------------------------------------------------------

/** The core kind of a note. Order matches ITGmania's TapNoteType. */
export enum TapNoteType {
  Empty,
  Tap,
  HoldHead,
  HoldTail,
  Mine,
  Lift,
  Attack,
  AutoKeysound,
  Fake,
}

/** Only meaningful when type === HoldHead. */
export enum TapNoteSubType {
  Hold,
  Roll,
  Invalid,
}

/**
 * Judgment score of a tap. Numeric order matches ITGmania and is load-bearing:
 * the hit ladder is Miss < W5 < W4 < W3 < W2 < W1, so `score >= W3` is valid.
 */
export enum TapNoteScore {
  None = 0,
  HitMine = 1,
  AvoidMine = 2,
  CheckpointMiss = 3,
  Miss = 4,
  W5 = 5,
  W4 = 6,
  W3 = 7,
  W2 = 8,
  W1 = 9,
  CheckpointHit = 10,
}

/** Final outcome of a hold/roll. */
export enum HoldNoteScore {
  None = 0,
  LetGo = 1,
  Held = 2,
  Missed = 3,
}

/** Runtime judgment state for a tap (populated during gameplay, not by the loader). */
export interface TapNoteResult {
  tns: TapNoteScore;
  /** Timing error in seconds; negative = early, positive = late. */
  tapNoteOffset: number;
  hidden: boolean;
  held: boolean;
}

/** Runtime state for a hold/roll. */
export interface HoldNoteResult {
  hns: HoldNoteScore;
  /** 1.0 = full, 0.0 = dead. First time it reaches 0 -> LetGo. */
  life: number;
  lastHeldRow: number;
  active: boolean;
  held: boolean;
}

/**
 * One cell of a chart. Empty cells are never stored (see NoteData), so a
 * TapNote always represents something real. `result`/`holdResult` are attached
 * lazily by the gameplay engine.
 */
export interface TapNote {
  type: TapNoteType;
  /** Hold vs Roll; only read when type === HoldHead. */
  subType: TapNoteSubType;
  /** HoldHead only: length in rows. Tail row = headRow + durationRows. */
  durationRows: number;
  /** Index into the song's keysound list; -1 = none. */
  keysoundIndex: number;
  /** Owning player for routine charts; -1 = not player-specific. */
  player: number;
  result?: TapNoteResult;
  holdResult?: HoldNoteResult;
}

export const NO_KEYSOUND = -1;
export const NO_PLAYER = -1;

function baseNote(type: TapNoteType): TapNote {
  return {
    type,
    subType: TapNoteSubType.Invalid,
    durationRows: 0,
    keysoundIndex: NO_KEYSOUND,
    player: NO_PLAYER,
  };
}

export const makeTap = (): TapNote => baseNote(TapNoteType.Tap);
export const makeMine = (): TapNote => baseNote(TapNoteType.Mine);
export const makeLift = (): TapNote => baseNote(TapNoteType.Lift);
export const makeFake = (): TapNote => baseNote(TapNoteType.Fake);
export const makeAutoKeysound = (): TapNote => baseNote(TapNoteType.AutoKeysound);

export function makeHoldHead(sub: TapNoteSubType): TapNote {
  const n = baseNote(TapNoteType.HoldHead);
  n.subType = sub;
  n.durationRows = MAX_NOTE_ROW; // clamped when the tail is found
  return n;
}
