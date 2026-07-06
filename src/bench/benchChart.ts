/**
 * Deterministic synthetic chart generator for the render benchmark. Produces
 * an SSC string fed through the real simfile parser so the benchmark exercises
 * the exact same NoteData/Judge/renderer path as gameplay. Density is
 * parameterized (16th stream, jumps, freezes/rolls, mines) so scenarios can
 * dial anywhere from "hard chart" to "beyond worst case". Seeded PRNG — the
 * same options always yield the same chart, so runs are comparable across
 * machines.
 */

export interface BenchChartOpts {
  bpm: number;
  /** Chart length in 4/4 measures (16 rows each, 16th resolution). */
  measures: number;
  /** Place a 2-note jump every N beats (0 = never). */
  jumpEveryBeats?: number;
  /** Start a freeze every N beats (0 = never). */
  holdEveryBeats?: number;
  /** Freeze length in beats. */
  holdLenBeats?: number;
  /** Every Nth freeze becomes a roll (0 = never). */
  rollEveryNth?: number;
  /** Drop a mine every N beats, offset to the off-beat (0 = never). */
  mineEveryBeats?: number;
}

/** Small deterministic PRNG (mulberry32) so charts are stable across runs. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRACKS = 4;

/** Generate the note rows (16th resolution) for the given density options. */
function makeRows(o: BenchChartOpts): string[] {
  const totalRows = o.measures * 16;
  const rows: string[][] = Array.from({ length: totalRows }, () =>
    Array.from({ length: TRACKS }, () => '0'),
  );
  /** Last row (inclusive) each track is occupied by a freeze body. */
  const busyUntil = new Array<number>(TRACKS).fill(-1);
  const rnd = mulberry32(0x5eed);
  let lastStream = -1;
  let holdCount = 0;

  const freeTracks = (row: number, throughRow = row): number[] => {
    const free: number[] = [];
    for (let t = 0; t < TRACKS; t++) {
      if (busyUntil[t] >= row) continue;
      if (rows[row][t] !== '0') continue;
      // A freeze needs its whole body free of later placements; nothing is
      // placed ahead of the cursor, so the head/tail rows are all that matter.
      if (throughRow < totalRows && rows[Math.min(throughRow, totalRows - 1)][t] !== '0') continue;
      free.push(t);
    }
    return free;
  };
  const pick = (list: number[]): number => list[Math.floor(rnd() * list.length)];

  for (let r = 0; r < totalRows; r++) {
    const beat = r / 4;
    const onBeat = r % 4 === 0;

    // Freezes/rolls first — they occupy tracks for a while.
    if (onBeat && o.holdEveryBeats && beat % o.holdEveryBeats === 0) {
      const lenRows = Math.max(1, Math.round((o.holdLenBeats ?? 1) * 4));
      const tail = Math.min(totalRows - 1, r + lenRows);
      const free = freeTracks(r, tail);
      if (free.length > 0) {
        const t = pick(free);
        holdCount++;
        const isRoll = !!o.rollEveryNth && holdCount % o.rollEveryNth === 0;
        rows[r][t] = isRoll ? '4' : '2';
        rows[tail][t] = '3';
        busyUntil[t] = tail;
      }
    }

    // Mines ride the off-beat (row +2 of the beat).
    if (o.mineEveryBeats && r % (o.mineEveryBeats * 4) === 2) {
      const free = freeTracks(r);
      if (free.length > 0) rows[r][pick(free)] = 'M';
    }

    // Jumps on their beat, then the constant 16th stream everywhere else.
    if (onBeat && o.jumpEveryBeats && beat % o.jumpEveryBeats === 0) {
      const free = freeTracks(r).filter((t) => rows[r][t] === '0');
      if (free.length >= 2) {
        const a = pick(free);
        const b = pick(free.filter((t) => t !== a));
        rows[r][a] = '1';
        rows[r][b] = '1';
        lastStream = b;
        continue;
      }
    }
    const free = freeTracks(r).filter((t) => t !== lastStream && rows[r][t] === '0');
    if (free.length > 0) {
      const t = pick(free);
      rows[r][t] = '1';
      lastStream = t;
    }
  }

  return rows.map((cells) => cells.join(''));
}

/** Build the full SSC text for a benchmark chart. */
export function makeBenchSsc(o: BenchChartOpts): string {
  const rows = makeRows(o);
  const measures: string[] = [];
  for (let m = 0; m < o.measures; m++) {
    measures.push(rows.slice(m * 16, (m + 1) * 16).join('\n'));
  }
  return `#VERSION:0.83;
#TITLE:Render Benchmark;
#ARTIST:stepzone;
#MUSIC:none.ogg;
#OFFSET:0.000;
#BPMS:0.000=${o.bpm.toFixed(3)};
#NOTEDATA:;
#STEPSTYPE:dance-single;
#DIFFICULTY:Challenge;
#METER:20;
#NOTES:
${measures.join('\n,\n')}
;`;
}
