/**
 * The online protocol — shapes shared by the web client and the API functions
 * (api/), so the two can't drift. Pure TypeScript: no DOM, no Node, no
 * imports from the rest of the app. Everything the server accepts is
 * validated here with the same defensive style as app/scores.ts
 * (malformed input -> null, never throw), because the API must treat all
 * client input as hostile.
 *
 * M1 scope (async leaderboards, docs/ONLINE-MULTIPLAYER.md §3 mode 1):
 * submit a finished play keyed by chart content hash + music rate, fetch the
 * top rows for one board. Boards are partitioned by rate — a 1.5x clear is a
 * different board (§5.4). Identity is claim-on-first-submit: the client
 * invents a playerId + secret; the first submission binds them and later
 * submissions must present the same secret.
 */

// v2 adds server-side anti-cheat: every submission must declare the input
// device (only a gamepad/dance-pad is accepted — keyboard plays never reach
// the board) and carry the full replay of the run, which the server checks for
// plausibility before storing. v1 submissions no longer parse (the version
// gate rejects them), so old queued plays are dropped on load rather than
// silently accepted without the new evidence.
export const PROTOCOL_VERSION = 3;

/** Immutable identity of a chart (content hash) + display metadata that
 *  rides along for rendering boards without owning the simfile. */
export interface ChartRef {
  /** chartContentHash(song, chart) — see src/song/chartHash.ts. */
  chartHash: string;
  title: string;
  artist: string;
  stepsType: string;
  /** Difficulty enum value (song/difficulty). */
  difficulty: number;
  meter: number;
}

/** Final result of one play; mirrors what Play.tsx already records locally. */
export interface PlayResult {
  /** percentDancePoints, 0..1. */
  percent: number;
  grade: string;
  maxCombo: number;
  failed: boolean;
  /** TapNoteScore -> count. */
  counts: Record<number, number>;
  /** HoldNoteScore -> count. */
  holdCounts: Record<number, number>;
}

/** One sample of a play's scoreboard timeline, for "race the ghost". */
export interface GhostFrame {
  /** Song-seconds when the sample was taken. */
  atSong: number;
  /** percentDancePoints at that moment, 0..1. */
  percent: number;
  combo: number;
  /** Life bar 0..1. */
  life: number;
}

/** One judged-relevant input from a play: a press or release on a column at a
 *  song-second, recorded by the engine and replayable frame-for-frame. `t` is
 *  the same song-seconds value fed to the judge (rounded to 4 decimals). */
export interface ReplayEvent {
  /** Song-seconds of the event (the judge's own time axis). */
  t: number;
  /** Column index (dance-single 0..3; up to 15 for wider styles). */
  track: number;
  /** True = release (key up), false = press (key down). */
  up: boolean;
}

/** How a submitted play was controlled. Only a gamepad/dance-pad is accepted —
 *  keyboard plays are held back client-side and never submitted, and the server
 *  rejects any device but 'pad'. */
export interface SubmitInput {
  device: 'pad';
  /** Gamepad.id of the pad that played (diagnostics + pad-known heuristic). */
  padId: string;
  /** True when padId matched a known dance-pad name (src/input/padDetect.ts). */
  padKnown: boolean;
}

/**
 * The chart a play ran on, shipped so a STATELESS server can re-simulate the
 * replay against it (v3 anti-cheat). The server recomputes the content hash of
 * these parts and rejects the submission unless it equals `chart.chartHash` —
 * so the payload is the exact chart that board is keyed on, no easier
 * substitute. `noteData` is the raw `#NOTES` grid; `timing` is the resolved
 * per-chart timing (only the segments that affect beat<->time and judgability).
 */
export interface ChartData {
  stepsType: string;
  /** Raw note grid string (hashed verbatim, then parsed to re-simulate). */
  noteData: string;
  timing: {
    offset: number;
    bpms: Array<{ row: number; bps: number }>;
    stops: Array<{ row: number; seconds: number }>;
    delays: Array<{ row: number; seconds: number }>;
    warps: Array<{ row: number; lengthRows: number }>;
    fakes: Array<{ row: number; lengthRows: number }>;
  };
}

export interface SubmitScoreRequest {
  protocol: typeof PROTOCOL_VERSION;
  playerId: string;
  /** Claim-on-first-submit credential; server stores only a hash of it. */
  secret: string;
  playerName: string;
  chart: ChartRef;
  /** Music rate this play used (1 = normal); boards partition on it. */
  musicRate: number;
  /** The client's claimed result — NOT trusted for ranking: the server
   *  re-simulates the replay and stores the score IT computes (v3). */
  result: PlayResult;
  /** Device the play ran on — must be a pad (anti-cheat, v2). */
  input: SubmitInput;
  /** The chart, so the server can re-run the replay against it (v3). */
  chartData: ChartData;
  /** Full input log of the play; the server RE-SIMULATES it to derive the
   *  authoritative score, and stores it (alongside the ghost) on a new best. */
  replay: ReplayEvent[];
  /** Scoreboard timeline of this play; stored only when it sets a new best. */
  ghost?: GhostFrame[];
}

export interface SubmitScoreResponse {
  ok: true;
  /** 1-based rank of this player's best on the board after the submit. */
  rank: number;
  /** True if this play improved (or created) the player's stored best. */
  isPersonalBest: boolean;
}

export interface LeaderboardRow {
  rank: number;
  playerId: string;
  playerName: string;
  percent: number;
  grade: string;
  maxCombo: number;
  failed: boolean;
  /** Unix ms of the play that set this best. */
  at: number;
  /** True when a ghost timeline is stored for this best (racable). */
  hasGhost: boolean;
  /** True when a replay is stored for this best (watchable). */
  hasReplay: boolean;
}

/** GET ?chartHash=..&rate=..&ghostOf=playerId */
export interface GhostResponse {
  ghost: GhostFrame[];
}

/** GET ?chartHash=..&rate=..&replayOf=playerId */
export interface ReplayResponse {
  replay: ReplayEvent[];
}

export interface LeaderboardResponse {
  rows: LeaderboardRow[];
  /** Total players on this board (may exceed rows.length). */
  total: number;
}

export interface ApiError {
  ok: false;
  code: string;
  message: string;
}

/** Boards key rates as integer percent (1.0 -> 100, 1.5 -> 150) so float
 *  representation can never split one board into two. */
export function rateKey(musicRate: number): number {
  return Math.round(musicRate * 100);
}

// ---- validation ---------------------------------------------------------------

const MAX_NAME_LENGTH = 24;
const MAX_STRING_LENGTH = 256;
/** Ids/secrets are client-invented (crypto.randomUUID or similar). */
const MAX_ID_LENGTH = 64;
/** Sanity ceiling on any judgment tally — no real chart comes close. */
const MAX_COUNT = 100_000;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const finiteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

/** Judgment tallies: small-int keys, sane non-negative-int values. */
function parseCounts(v: unknown): Record<number, number> | null {
  if (!isObj(v)) return null;
  const out: Record<number, number> = {};
  for (const [k, n] of Object.entries(v)) {
    const key = Number(k);
    if (!Number.isInteger(key) || key < 0 || key > 32) return null;
    if (!finiteNum(n) || !Number.isInteger(n) || n < 0 || n > MAX_COUNT) return null;
    out[key] = n;
  }
  return out;
}

export function parseChartRef(v: unknown): ChartRef | null {
  if (!isObj(v)) return null;
  if (!str(v.chartHash, MAX_ID_LENGTH)) return null;
  if (!str(v.title, MAX_STRING_LENGTH) || typeof v.artist !== 'string') return null;
  if (v.artist.length > MAX_STRING_LENGTH) return null;
  if (!str(v.stepsType, MAX_STRING_LENGTH)) return null;
  if (!finiteNum(v.difficulty) || !Number.isInteger(v.difficulty)) return null;
  if (!finiteNum(v.meter) || !Number.isInteger(v.meter) || v.meter < 0 || v.meter > 100)
    return null;
  return {
    chartHash: v.chartHash,
    title: v.title,
    artist: v.artist,
    stepsType: v.stepsType,
    difficulty: v.difficulty,
    meter: v.meter,
  };
}

export function parsePlayResult(v: unknown): PlayResult | null {
  if (!isObj(v)) return null;
  if (!finiteNum(v.percent) || v.percent < 0 || v.percent > 1) return null;
  if (!str(v.grade, 8)) return null;
  if (!finiteNum(v.maxCombo) || !Number.isInteger(v.maxCombo)) return null;
  if (v.maxCombo < 0 || v.maxCombo > MAX_COUNT) return null;
  if (typeof v.failed !== 'boolean') return null;
  const counts = parseCounts(v.counts);
  const holdCounts = parseCounts(v.holdCounts);
  if (!counts || !holdCounts) return null;
  return {
    percent: v.percent,
    grade: v.grade,
    maxCombo: v.maxCombo,
    failed: v.failed,
    counts,
    holdCounts,
  };
}

/** Ghost timelines are capped hard — ~8 minutes at the 2 Hz capture rate. */
export const MAX_GHOST_FRAMES = 1000;

export function parseGhost(v: unknown): GhostFrame[] | null {
  if (!Array.isArray(v) || v.length > MAX_GHOST_FRAMES) return null;
  const out: GhostFrame[] = [];
  let prevAt = Number.NEGATIVE_INFINITY;
  for (const f of v) {
    if (!isObj(f)) return null;
    if (!finiteNum(f.atSong) || f.atSong < -60 || f.atSong > 36_000) return null;
    if (f.atSong < prevAt) return null; // must advance with the song
    if (!finiteNum(f.percent) || f.percent < 0 || f.percent > 1) return null;
    if (!finiteNum(f.combo) || !Number.isInteger(f.combo) || f.combo < 0 || f.combo > MAX_COUNT)
      return null;
    if (!finiteNum(f.life) || f.life < 0 || f.life > 1) return null;
    prevAt = f.atSong;
    out.push({ atSong: f.atSong, percent: f.percent, combo: f.combo, life: f.life });
  }
  return out;
}

/** Replays are capped hard — a long marathon at a heavy stream stays well
 *  under this, and the number bounds both the request body and stored blob. */
export const MAX_REPLAY_EVENTS = 30_000;
/** Pad ids are browser-provided (Gamepad.id); long but bounded. */
const MAX_PAD_ID_LENGTH = 128;

export function parseReplay(v: unknown): ReplayEvent[] | null {
  if (!Array.isArray(v) || v.length > MAX_REPLAY_EVENTS) return null;
  const out: ReplayEvent[] = [];
  let prevT = Number.NEGATIVE_INFINITY;
  for (const e of v) {
    if (!isObj(e)) return null;
    if (!finiteNum(e.t) || e.t < -60 || e.t > 36_000) return null;
    if (e.t < prevT) return null; // events are recorded in time order
    if (!finiteNum(e.track) || !Number.isInteger(e.track) || e.track < 0 || e.track > 15)
      return null;
    if (typeof e.up !== 'boolean') return null;
    prevT = e.t;
    out.push({ t: e.t, track: e.track, up: e.up });
  }
  return out;
}

/** A raw note grid dwarfs everything else in a submission; cap it well above
 *  any real chart (dense marathons are tens of KB) but below abuse — this also
 *  bounds how many notes the server re-simulates (anti-DoS). */
export const MAX_NOTE_DATA_CHARS = 256 * 1024;
/** Even the gimmick-heaviest real chart has a few hundred timing changes; a
 *  low cap keeps the server's beat<->time scan (O(notes × segments)) cheap. */
const MAX_TIMING_SEGMENTS = 2_000;
/** Note rows are non-negative integers; a sane ceiling rejects garbage rows. */
const MAX_ROW = 1 << 28;

function parseRowSegments<T>(
  v: unknown,
  field: 'bps' | 'seconds' | 'lengthRows',
  make: (row: number, value: number) => T,
): T[] | null {
  if (!Array.isArray(v) || v.length > MAX_TIMING_SEGMENTS) return null;
  const out: T[] = [];
  for (const s of v) {
    if (!isObj(s)) return null;
    if (!finiteNum(s.row) || !Number.isInteger(s.row) || s.row < 0 || s.row > MAX_ROW) return null;
    const value = s[field];
    if (!finiteNum(value)) return null;
    if (field === 'lengthRows' && (!Number.isInteger(value) || value < 0)) return null;
    out.push(make(s.row, value));
  }
  return out;
}

export function parseChartData(v: unknown): ChartData | null {
  if (!isObj(v)) return null;
  if (!str(v.stepsType, MAX_STRING_LENGTH)) return null;
  if (typeof v.noteData !== 'string' || v.noteData.length > MAX_NOTE_DATA_CHARS) return null;
  if (!isObj(v.timing)) return null;
  const t = v.timing;
  if (!finiteNum(t.offset)) return null;
  const bpms = parseRowSegments(t.bpms, 'bps', (row, bps) => ({ row, bps }));
  const stops = parseRowSegments(t.stops, 'seconds', (row, seconds) => ({ row, seconds }));
  const delays = parseRowSegments(t.delays, 'seconds', (row, seconds) => ({ row, seconds }));
  const warps = parseRowSegments(t.warps, 'lengthRows', (row, lengthRows) => ({ row, lengthRows }));
  const fakes = parseRowSegments(t.fakes, 'lengthRows', (row, lengthRows) => ({ row, lengthRows }));
  if (!bpms || !stops || !delays || !warps || !fakes) return null;
  return {
    stepsType: v.stepsType,
    noteData: v.noteData,
    timing: { offset: t.offset, bpms, stops, delays, warps, fakes },
  };
}

/** Input device declaration; only a pad is accepted (keyboard never submits). */
export function parseSubmitInput(v: unknown): SubmitInput | null {
  if (!isObj(v)) return null;
  if (v.device !== 'pad') return null;
  if (!str(v.padId, MAX_PAD_ID_LENGTH)) return null;
  if (typeof v.padKnown !== 'boolean') return null;
  return { device: 'pad', padId: v.padId, padKnown: v.padKnown };
}

export function parseSubmitScoreRequest(v: unknown): SubmitScoreRequest | null {
  if (!isObj(v)) return null;
  if (v.protocol !== PROTOCOL_VERSION) return null;
  if (!str(v.playerId, MAX_ID_LENGTH) || !str(v.secret, MAX_ID_LENGTH)) return null;
  if (!str(v.playerName, MAX_NAME_LENGTH)) return null;
  const chart = parseChartRef(v.chart);
  const result = parsePlayResult(v.result);
  if (!chart || !result) return null;
  if (!finiteNum(v.musicRate) || v.musicRate < 0.5 || v.musicRate > 3) return null;
  // A combo can't exceed the number of judged steps.
  let judged = 0;
  for (const n of Object.values(result.counts)) judged += n;
  if (result.maxCombo > judged) return null;
  // Device + chart + replay are required in v3 (anti-cheat). A malformed one is
  // tampering, not version skew — our own client always sends them well-formed.
  const input = parseSubmitInput(v.input);
  const chartData = parseChartData(v.chartData);
  const replay = parseReplay(v.replay);
  if (!input || !chartData || !replay) return null;
  // A ghost is optional, but a malformed one rejects the submission (our own
  // client never sends one, so it is tampering, not version skew).
  let ghost: GhostFrame[] | undefined;
  if (v.ghost !== undefined) {
    const parsed = parseGhost(v.ghost);
    if (!parsed) return null;
    ghost = parsed;
  }
  return {
    protocol: PROTOCOL_VERSION,
    playerId: v.playerId,
    secret: v.secret,
    playerName: v.playerName,
    chart,
    musicRate: v.musicRate,
    result,
    input,
    chartData,
    replay,
    ...(ghost !== undefined ? { ghost } : {}),
  };
}
