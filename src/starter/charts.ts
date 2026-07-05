/**
 * Handcrafted charts for the starter songs. A measure is a space-separated
 * string of rows (LDUR columns, StepMania note chars: 1 tap, 2/3 hold
 * head/end); 4 rows = quarter notes, 8 = eighths, 16 = sixteenths. Charts are
 * built from repeated section patterns, mirroring how the music itself loops —
 * see songs.ts for the section maps (measure counts must equal the song's
 * bars).
 */

export type MeasureRun = [measure: string, repeat: number];

export interface StarterChartDef {
  /** SSC difficulty tag (Beginner/Easy/Medium/Hard/Challenge). */
  difficulty: string;
  meter: number;
  measures: MeasureRun[];
}

/** Expand measure runs into an #NOTES body (rows joined, measures by commas). */
export function expandNotes(measures: MeasureRun[]): string {
  const out: string[] = [];
  for (const [m, rep] of measures) {
    for (let i = 0; i < rep; i++) out.push(m.split(' ').join('\n'));
  }
  return out.join('\n,\n');
}

/** Total measures in a run list (tests assert this equals the song's bars). */
export function measureCount(measures: MeasureRun[]): number {
  return measures.reduce((n, [, rep]) => n + rep, 0);
}

/** a, b alternated n times each (a b a b …). */
function alt(a: string, b: string, n: number): MeasureRun[] {
  const out: MeasureRun[] = [];
  for (let i = 0; i < n; i++) out.push([a, 1], [b, 1]);
  return out;
}

// Shared building blocks -----------------------------------------------------
const REST = '0000 0000 0000 0000';
// Single taps on the downbeat.
const dL = '1000 0000 0000 0000';
const dD = '0100 0000 0000 0000';
const dU = '0010 0000 0000 0000';
const dR = '0001 0000 0000 0000';
// Taps on beats 1 & 3 (the verse kick).
const kLD = '1000 0000 0100 0000';
const kRU = '0001 0000 0010 0000';
// Quarter-note staircases.
const sLDUR = '1000 0100 0010 0001';
const sRUDL = '0001 0010 0100 1000';
// Full-bar eighth staircases (8 rows).
const e8a = '1000 0100 0010 0001 1000 0100 0010 0001';
const e8b = '0001 0010 0100 1000 0001 0010 0100 1000';

export const STARTER_CHARTS: Record<string, StarterChartDef[]> = {
  // --- FIRST STEPS (40 bars: 4 intro · 8 verse · 8 chorus · 8 verse · 8 chorus · 4 outro)
  'First Steps': [
    {
      difficulty: 'Beginner',
      meter: 1,
      measures: [
        [REST, 4],
        ...alt(dL, dR, 4), // verse: one arrow per bar
        ...alt('0100 0000 0010 0000', '0010 0000 0100 0000', 4), // chorus: beats 1 & 3
        ...alt(dD, dU, 4),
        ...alt('0100 0000 0010 0000', '0010 0000 0100 0000', 4),
        [REST, 3],
        [dD, 1],
      ],
    },
    {
      difficulty: 'Easy',
      meter: 2,
      measures: [
        [REST, 2],
        [kLD, 1],
        [kRU, 1],
        ...alt(kLD, kRU, 4),
        ...alt('1000 0100 0010 0000', '0001 0010 0100 0000', 4), // chorus: 3 quarters
        ...alt(kRU, kLD, 4),
        ...alt('0001 0010 0100 0000', '1000 0100 0010 0000', 4),
        [kLD, 1],
        [kRU, 1],
        [REST, 1],
        [dD, 1],
      ],
    },
    {
      difficulty: 'Medium',
      meter: 4,
      measures: [
        [REST, 1],
        [dL, 1],
        [dR, 1],
        [kLD, 1],
        ...alt(sLDUR, sRUDL, 4), // verse: quarter staircases
        // chorus: two taps then a right/left hold through the long lead note
        ...alt(
          '1000 0000 0100 0000 0002 0000 0000 0003',
          '0001 0000 0010 0000 2000 0000 0000 3000',
          4,
        ),
        ...alt(sRUDL, sLDUR, 4),
        ...alt(
          '0001 0000 0010 0000 2000 0000 0000 3000',
          '1000 0000 0100 0000 0002 0000 0000 0003',
          4,
        ),
        [kLD, 1],
        [kRU, 1],
        [REST, 1],
        ['1001 0000 0000 0000', 1], // closing jump on the crash
      ],
    },
  ],

  // --- NEON CIRCUIT (56 bars: 8 intro · 16 verse · 16 chorus · 8 break · 8 chorus)
  'Neon Circuit': [
    {
      difficulty: 'Easy',
      meter: 3,
      measures: [
        [REST, 4],
        ...alt(dL, dR, 2),
        ...alt(kLD, kRU, 8), // verse rides the kick
        ...alt('1000 0100 0010 0000', '0001 0010 0100 0000', 8),
        ...alt(dD, dU, 4), // break floats
        ...alt('1000 0100 0010 0000', '0001 0010 0100 0000', 4),
      ],
    },
    {
      difficulty: 'Medium',
      meter: 5,
      measures: [
        [REST, 2],
        [kLD, 1],
        [kRU, 1],
        [sLDUR, 1],
        [sRUDL, 1],
        [kLD, 1],
        [kRU, 1],
        ...alt(sLDUR, sRUDL, 8), // verse: four-on-the-floor quarters
        // chorus: quarters plus an eighth pickup into the next bar
        ...alt(
          '1000 0000 0100 0000 0010 0000 0001 0100',
          '0001 0000 0010 0000 0100 0000 1000 0010',
          8,
        ),
        // break: long holds under the pads
        ...alt(
          '2000 0000 0000 0000 0000 0000 0000 3000',
          '0002 0000 0000 0000 0000 0000 0000 0003',
          4,
        ),
        ...alt(
          '0001 0000 0010 0000 0100 0000 1000 0010',
          '1000 0000 0100 0000 0010 0000 0001 0100',
          4,
        ),
      ],
    },
    {
      difficulty: 'Hard',
      meter: 7,
      measures: [
        [REST, 2],
        [sLDUR, 1],
        [sRUDL, 1],
        ...alt(e8a, e8b, 2), // intro: streams once the kick lands
        // verse: quarters with a stream every fourth bar
        [sLDUR, 1],
        [sRUDL, 1],
        [sLDUR, 1],
        [e8a, 1],
        [sRUDL, 1],
        [sLDUR, 1],
        [sRUDL, 1],
        [e8b, 1],
        [sLDUR, 1],
        [sRUDL, 1],
        [sLDUR, 1],
        [e8a, 1],
        [sRUDL, 1],
        [sLDUR, 1],
        [sRUDL, 1],
        [e8b, 1],
        // chorus: jump on the crash, then eighth streams
        ['1001 0000 0010 0100 1000 0100 0010 0001', 1],
        [e8b, 1],
        [e8a, 1],
        [e8b, 1],
        [e8a, 1],
        [e8b, 1],
        [e8a, 1],
        ['0001 0010 0100 1000 0100 0010 1000 0000', 1],
        ['1001 0000 0010 0100 1000 0100 0010 0001', 1],
        [e8b, 1],
        [e8a, 1],
        [e8b, 1],
        [e8a, 1],
        [e8b, 1],
        [e8a, 1],
        ['0001 0010 0100 1000 0100 0010 1000 0000', 1],
        // break: one foot holds, the other walks
        ...alt(
          '2000 0000 0100 0000 0010 0000 0000 3000',
          '0002 0000 0010 0000 0100 0000 0000 0003',
          4,
        ),
        ['1001 0000 0010 0100 1000 0100 0010 0001', 1],
        [e8b, 1],
        [e8a, 1],
        [e8b, 1],
        [e8a, 1],
        [e8b, 1],
        [e8a, 1],
        ['1001 0000 0000 0000', 1],
      ],
    },
  ],

  // --- OVERDRIVE (64 bars: 8 intro · 16 A · 16 B · 8 bridge · 16 B)
  Overdrive: [
    {
      difficulty: 'Medium',
      meter: 6,
      measures: [
        [REST, 2],
        [kLD, 1],
        [kRU, 1],
        ...alt(sLDUR, sRUDL, 2),
        // A: quarter staircases, eighth tail every fourth bar
        [sLDUR, 1],
        [sRUDL, 1],
        [sLDUR, 1],
        ['1000 0000 0100 0000 0010 0000 0001 0100', 1],
        [sRUDL, 1],
        [sLDUR, 1],
        [sRUDL, 1],
        ['0001 0000 0010 0000 0100 0000 1000 0010', 1],
        [sLDUR, 1],
        [sRUDL, 1],
        [sLDUR, 1],
        ['1000 0000 0100 0000 0010 0000 0001 0100', 1],
        [sRUDL, 1],
        [sLDUR, 1],
        [sRUDL, 1],
        ['0001 0000 0010 0000 0100 0000 1000 0010', 1],
        // B: quarters with eighth pairs on the riff
        ...alt(
          '1000 0000 0100 0010 0001 0000 0100 0010',
          '0001 0000 0010 0100 1000 0000 0010 0100',
          8,
        ),
        ...alt(kLD, kRU, 4), // bridge: half-time
        ...alt(
          '0001 0000 0010 0100 1000 0000 0010 0100',
          '1000 0000 0100 0010 0001 0000 0100 0010',
          8,
        ),
      ],
    },
    {
      difficulty: 'Hard',
      meter: 9,
      measures: [
        [REST, 1],
        [sLDUR, 1],
        [sRUDL, 1],
        [sLDUR, 1],
        ...alt(e8a, e8b, 2),
        // A: sustained eighth streams
        [e8a, 1],
        [e8b, 1],
        ['1000 0100 0010 0100 1000 0100 0010 0001', 1],
        ['0001 0010 0100 0010 0001 0010 0100 1000', 1],
        [e8a, 1],
        [e8b, 1],
        ['1000 0100 0010 0100 1000 0100 0010 0001', 1],
        ['0001 0010 0100 0010 0001 0010 0100 1000', 1],
        [e8a, 1],
        [e8b, 1],
        ['1000 0100 0010 0100 1000 0100 0010 0001', 1],
        ['0001 0010 0100 0010 0001 0010 0100 1000', 1],
        [e8a, 1],
        [e8b, 1],
        ['1000 0100 0010 0100 1000 0100 0010 0001', 1],
        ['0001 0010 0100 0010 0001 0010 0100 1000', 1],
        // B: jump accents into streams
        ['1001 0000 0100 0010 1000 0010 0100 0001', 1],
        [e8b, 1],
        [e8a, 1],
        ['0110 0000 0010 0100 0001 0100 0010 1000', 1],
        ['1001 0000 0100 0010 1000 0010 0100 0001', 1],
        [e8b, 1],
        [e8a, 1],
        ['0110 0000 0010 0100 0001 0100 0010 1000', 1],
        ['1001 0000 0100 0010 1000 0010 0100 0001', 1],
        [e8b, 1],
        [e8a, 1],
        ['0110 0000 0010 0100 0001 0100 0010 1000', 1],
        ['1001 0000 0100 0010 1000 0010 0100 0001', 1],
        [e8b, 1],
        [e8a, 1],
        ['0110 0000 0010 0100 0001 0100 0010 1000', 1],
        ...alt(sLDUR, sRUDL, 4), // bridge breather
        ['1001 0000 0100 0010 1000 0010 0100 0001', 1],
        [e8b, 1],
        [e8a, 1],
        ['0110 0000 0010 0100 0001 0100 0010 1000', 1],
        ['1001 0000 0100 0010 1000 0010 0100 0001', 1],
        [e8b, 1],
        [e8a, 1],
        ['0110 0000 0010 0100 0001 0100 0010 1000', 1],
        ['1001 0000 0100 0010 1000 0010 0100 0001', 1],
        [e8b, 1],
        [e8a, 1],
        ['0110 0000 0010 0100 0001 0100 0010 1000', 1],
        ['1001 0000 0100 0010 1000 0010 0100 0001', 1],
        [e8b, 1],
        [e8a, 1],
        ['1001 0000 0000 0000', 1],
      ],
    },
    {
      difficulty: 'Challenge',
      meter: 11,
      // The 16-row measure: eighths for three beats, a sixteenth burst on the
      // drum fill (beats 3–4: U R D L), matching the triple kick in songs.ts.
      measures: (() => {
        const bst =
          '1000 0000 0100 0000 0010 0000 0001 0000 1000 0000 0100 0000 0010 0001 0100 1000';
        const jX = '1001 0000 0100 0010 1000 0010 0100 0001';
        const phraseA: MeasureRun[] = [
          [e8a, 1],
          [e8b, 1],
          [e8a, 1],
          [bst, 1],
        ];
        const phraseB: MeasureRun[] = [
          [jX, 1],
          [e8b, 1],
          [e8a, 1],
          [bst, 1],
        ];
        return [
          [REST, 1],
          [e8a, 1],
          [e8b, 1],
          [e8a, 1],
          [e8b, 1],
          [e8a, 1],
          [e8b, 1],
          [bst, 1],
          ...phraseA,
          ...phraseA,
          ...phraseA,
          ...phraseA,
          ...phraseB,
          ...phraseB,
          ...phraseB,
          ...phraseB,
          ...alt(
            '2000 0000 0100 0000 0010 0000 0000 3000',
            '0002 0000 0010 0000 0100 0000 0000 0003',
            4,
          ),
          ...phraseB,
          ...phraseB,
          ...phraseB,
          [jX, 1],
          [e8b, 1],
          [e8a, 1],
          ['1001 0000 0000 0000', 1],
        ] as MeasureRun[];
      })(),
    },
  ],
};
