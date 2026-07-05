/**
 * The bundled starter songs: three original Stepzone compositions, written as
 * beat-grid specs for the deterministic synth (trackSynth.ts). Charts for them
 * live in charts.ts on the same grid, so music and steps line up exactly.
 * Everything here is first-party — no licensed material.
 */

import type { DrumHit, DrumKind, TrackSpec, VoiceNote } from './trackSynth';

// MIDI shorthand (C4 = 60).
const C2 = 36,
  D2 = 38,
  E2 = 40,
  F2 = 41,
  G2 = 43,
  A2 = 45;
const b3 = 59;
const c4 = 60,
  d4 = 62,
  e4 = 64,
  f4 = 65,
  g4 = 67,
  a4 = 69,
  b4 = 71;
const c5 = 72,
  d5 = 74,
  e5 = 76;

/** [beatInBar, midi, lengthBeats, velocity?] */
type Pat = Array<[number, number, number, number?]>;

function mel(out: VoiceNote[], bar: number, pat: Pat): void {
  for (const [b, midi, d, v] of pat) out.push({ b: bar * 4 + b, midi, d, v });
}

function hit(out: DrumHit[], bar: number, hits: Array<[number, DrumKind, number?]>): void {
  for (const [b, kind, v] of hits) out.push({ b: bar * 4 + b, kind, v });
}

const KICK2 = [
  [0, 'kick'],
  [2, 'kick'],
] as Array<[number, DrumKind]>;
const BACKBEAT = [
  [1, 'snare'],
  [3, 'snare'],
] as Array<[number, DrumKind]>;
const HATS_8 = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((b) => [b, 'hat'] as [number, DrumKind]);
const HATS_4 = [0, 1, 2, 3].map((b) => [b, 'hat'] as [number, DrumKind]);
const FOUR_FLOOR = [0, 1, 2, 3].map((b) => [b, 'kick'] as [number, DrumKind]);
const OFF_HATS = [0.5, 1.5, 2.5, 3.5].map((b) => [b, 'hat'] as [number, DrumKind]);

// --- FIRST STEPS — 100 BPM, C major, 40 bars ------------------------------
// intro 4 · verse 8 · chorus 8 · verse 8 · chorus 8 · outro 4

function firstSteps(): TrackSpec {
  const lead: VoiceNote[] = [];
  const bass: VoiceNote[] = [];
  const drums: DrumHit[] = [];
  const roots = [C2, G2, A2, F2]; // C  G  Am  F

  const verseMel: Pat[] = [
    [
      [0, e4, 0.9],
      [1, g4, 0.9],
      [2, a4, 0.9],
      [3, g4, 0.9],
    ],
    [
      [0, d4, 0.9],
      [1, g4, 0.9],
      [2, b4, 0.9],
      [3, g4, 0.9],
    ],
    [
      [0, c4, 0.9],
      [1, e4, 0.9],
      [2, a4, 0.9],
      [3, e4, 0.9],
    ],
    [
      [0, f4, 0.9],
      [1, a4, 0.9],
      [2, c5, 1.8],
    ],
  ];
  const verseEnd: Pat = [
    [0, f4, 0.9],
    [1, e4, 0.9],
    [2, d4, 0.9],
    [3, c4, 1.9],
  ];
  const chorusMel: Pat[] = [
    [
      [0, c5, 0.9],
      [1, c5, 0.45],
      [1.5, b4, 0.45],
      [2, a4, 0.9],
      [3, g4, 0.9],
    ],
    [
      [0, b4, 0.9],
      [1, g4, 0.9],
      [2, d5, 1.8],
    ],
    [
      [0, a4, 0.9],
      [1, a4, 0.45],
      [1.5, g4, 0.45],
      [2, e4, 0.9],
      [3, g4, 0.9],
    ],
    [
      [0, f4, 0.9],
      [1, g4, 0.9],
      [2, a4, 1.8],
    ],
  ];
  const chorusEnd: Pat = [
    [0, f4, 0.9],
    [1, g4, 0.9],
    [2, c5, 1.8],
  ];

  for (let bar = 0; bar < 40; bar++) {
    const root = roots[bar % 4];
    if (bar < 4 || bar >= 36) {
      // intro / outro: long bass, light percussion
      bass.push({ b: bar * 4, midi: root, d: 3.6 });
      hit(drums, bar, [[0, 'kick'], ...HATS_4]);
      if (bar === 36) mel(lead, bar, [[0, c5, 3.8]]);
      if (bar === 39) hit(drums, bar, [[0, 'crash']]);
    } else if ((bar >= 4 && bar < 12) || (bar >= 20 && bar < 28)) {
      // verse: half-note bass, kick 1&3, snare backbeat
      bass.push({ b: bar * 4, midi: root, d: 1.8 }, { b: bar * 4 + 2, midi: root, d: 1.8 });
      hit(drums, bar, [...KICK2, ...BACKBEAT, ...HATS_8]);
      const p = (bar - (bar < 12 ? 4 : 20)) % 8;
      mel(lead, bar, p === 7 ? verseEnd : verseMel[p % 4]);
    } else {
      // chorus: quarter bass, crash on entry
      for (let q = 0; q < 4; q++) bass.push({ b: bar * 4 + q, midi: root, d: 0.9 });
      const p = (bar - (bar < 20 ? 12 : 28)) % 8;
      hit(drums, bar, [...KICK2, ...BACKBEAT, ...HATS_8, [3.5, 'ohat']]);
      if (p === 0) hit(drums, bar, [[0, 'crash']]);
      mel(lead, bar, p === 7 ? chorusEnd : chorusMel[p % 4]);
    }
  }
  return { bpm: 100, beats: 160, lead, bass, drums };
}

// --- NEON CIRCUIT — 128 BPM, A minor, 56 bars ------------------------------
// intro 8 · verse 16 · chorus 16 · break 8 · chorus 8

function neonCircuit(): TrackSpec {
  const lead: VoiceNote[] = [];
  const bass: VoiceNote[] = [];
  const arp: VoiceNote[] = [];
  const drums: DrumHit[] = [];
  const roots = [A2, F2, C2, G2]; // Am  F  C  G
  const third = [3, 4, 4, 4]; // minor third only on Am

  const arpBar = (bar: number) => {
    const r = roots[bar % 4] + 12;
    const steps = [0, third[bar % 4], 7, 12, 7, third[bar % 4], 0, 7];
    steps.forEach((iv, i) => arp.push({ b: bar * 4 + i * 0.5, midi: r + iv, d: 0.4 }));
  };
  const vMel: Pat[] = [
    [
      [0, a4, 2.7],
      [3, g4, 0.9],
    ],
    [
      [0, f4, 1.8],
      [2, e4, 1.8],
    ],
    [
      [0, e4, 0.9],
      [1, g4, 0.9],
      [2, a4, 1.8],
    ],
    [],
  ];
  const vMelAlt: Pat = [
    [0, c5, 1.8],
    [2, b4, 1.8],
  ];
  const cMel: Pat[] = [
    [
      [0, a4, 0.45],
      [0.5, a4, 0.45],
      [1, c5, 0.9],
      [2, e5, 0.9],
      [3, d5, 0.45],
      [3.5, c5, 0.45],
    ],
    [
      [0, b4, 1.8],
      [2, g4, 1.8],
    ],
    [
      [0, f4, 0.45],
      [0.5, f4, 0.45],
      [1, a4, 0.9],
      [2, c5, 0.9],
      [3, b4, 0.45],
      [3.5, a4, 0.45],
    ],
    [
      [0, g4, 1.8],
      [2, e4, 1.8],
    ],
  ];
  const cMelAlt: Pat = [
    [0, d5, 1.8],
    [2, e5, 1.9],
  ];
  const breakMel = [a4, g4, f4, e4];

  for (let bar = 0; bar < 56; bar++) {
    const root = roots[bar % 4];
    const eighthBass = () => {
      for (let i = 0; i < 8; i++) bass.push({ b: bar * 4 + i * 0.5, midi: root, d: 0.4 });
    };
    if (bar < 8) {
      // intro: arp fades in, kick joins halfway
      arpBar(bar);
      hit(drums, bar, bar < 4 ? HATS_8 : [...FOUR_FLOOR, ...OFF_HATS]);
      if (bar >= 4) eighthBass();
    } else if (bar < 24) {
      // verse
      eighthBass();
      hit(drums, bar, [...FOUR_FLOOR, ...BACKBEAT, ...OFF_HATS]);
      if (bar === 8) hit(drums, bar, [[0, 'crash']]);
      const p = (bar - 8) % 8;
      mel(lead, bar, p === 7 ? vMelAlt : vMel[p % 4]);
    } else if (bar < 40 || bar >= 48) {
      // chorus (both of them)
      eighthBass();
      arpBar(bar);
      hit(drums, bar, [...FOUR_FLOOR, ...BACKBEAT, ...OFF_HATS, [3.5, 'ohat']]);
      const p = (bar - (bar < 40 ? 24 : 48)) % 8;
      if (p === 0) hit(drums, bar, [[0, 'crash']]);
      mel(lead, bar, p === 7 ? cMelAlt : cMel[p % 4]);
    } else {
      // break: floats — no kick, long notes
      bass.push({ b: bar * 4, midi: root, d: 3.7 });
      arpBar(bar);
      hit(drums, bar, HATS_4);
      mel(lead, bar, [[0, breakMel[(bar - 40) % 4], 3.7]]);
    }
  }
  return { bpm: 128, beats: 224, lead, bass, arp, drums };
}

// --- OVERDRIVE — 162 BPM, E minor, 64 bars ---------------------------------
// intro 8 · A 16 · B 16 · bridge 8 · B 16

function overdrive(): TrackSpec {
  const lead: VoiceNote[] = [];
  const bass: VoiceNote[] = [];
  const arp: VoiceNote[] = [];
  const drums: DrumHit[] = [];
  const roots = [E2, C2, G2, D2]; // Em  C  G  D

  const aMel: Pat[] = [
    [
      [0, e4, 0.45],
      [0.5, e4, 0.45],
      [1, g4, 0.45],
      [1.5, e4, 0.45],
      [2, a4, 0.9],
      [3, g4, 0.45],
      [3.5, e4, 0.45],
    ],
    [
      [0, e4, 0.45],
      [0.5, e4, 0.45],
      [1, g4, 0.45],
      [1.5, a4, 0.45],
      [2, b4, 1.8],
    ],
    [
      [0, e4, 0.45],
      [0.5, e4, 0.45],
      [1, g4, 0.45],
      [1.5, e4, 0.45],
      [2, a4, 0.9],
      [3, g4, 0.45],
      [3.5, e4, 0.45],
    ],
    [
      [0, d5, 0.45],
      [0.5, b4, 0.45],
      [1, a4, 0.45],
      [1.5, g4, 0.45],
      [2, a4, 1.8],
    ],
  ];
  const bMel: Pat[] = [
    [
      [0, e5, 0.9],
      [1, d5, 0.45],
      [1.5, b4, 0.45],
      [2, a4, 0.9],
      [3, b4, 0.9],
    ],
    [
      [0, g4, 0.45],
      [0.5, a4, 0.45],
      [1, b4, 0.45],
      [1.5, d5, 0.45],
      [2, e5, 1.8],
    ],
    [
      [0, d5, 0.9],
      [1, b4, 0.45],
      [1.5, a4, 0.45],
      [2, g4, 0.9],
      [3, a4, 0.9],
    ],
    [[0, b4, 3.6]],
  ];
  const bMelAlt: Pat = [
    [0, e5, 1.8],
    [2, d5, 1.8],
  ];
  const bridgeMel = [e4, d4, c4, b3];

  for (let bar = 0; bar < 64; bar++) {
    const root = roots[bar % 4];
    const drive = () => {
      for (let i = 0; i < 8; i++) bass.push({ b: bar * 4 + i * 0.5, midi: root, d: 0.35 });
    };
    const arpBar = () => {
      const r = root + 12;
      const q = bar % 4 === 0 ? 3 : 4; // Em minor, others major
      [0, q, 7, 12, 7, q, 0, 7].forEach((iv, i) =>
        arp.push({ b: bar * 4 + i * 0.5, midi: r + iv, d: 0.35 }),
      );
    };
    const fill =
      bar % 4 === 3
        ? ([
            [3.25, 'kick'],
            [3.5, 'kick'],
            [3.75, 'kick'],
          ] as Array<[number, DrumKind]>)
        : [];
    if (bar < 8) {
      // intro: riff builds — bass + hats, kicks from bar 4
      drive();
      hit(drums, bar, bar < 4 ? HATS_8 : [...FOUR_FLOOR, ...BACKBEAT, ...HATS_8]);
      if (bar >= 4) mel(lead, bar, aMel[bar % 4]);
    } else if (bar < 24) {
      drive();
      hit(drums, bar, [...FOUR_FLOOR, ...BACKBEAT, ...HATS_8, ...fill]);
      if (bar === 8) hit(drums, bar, [[0, 'crash']]);
      mel(lead, bar, aMel[(bar - 8) % 4]);
    } else if (bar < 40 || bar >= 48) {
      drive();
      arpBar();
      hit(drums, bar, [...FOUR_FLOOR, ...BACKBEAT, ...HATS_8, ...fill]);
      const p = (bar - (bar < 40 ? 24 : 48)) % 8;
      if (p === 0) hit(drums, bar, [[0, 'crash']]);
      mel(lead, bar, p === 7 ? bMelAlt : bMel[p % 4]);
    } else {
      // bridge: half-time
      bass.push({ b: bar * 4, midi: root, d: 1.8 }, { b: bar * 4 + 2, midi: root, d: 1.8 });
      arpBar();
      hit(drums, bar, [[0, 'kick'], [2, 'snare'], ...HATS_4]);
      mel(lead, bar, [[0, bridgeMel[(bar - 40) % 4], 3.8]]);
    }
  }
  return { bpm: 162, beats: 256, lead, bass, arp, drums };
}

export interface StarterSongDef {
  file: string;
  title: string;
  bpm: number;
  bars: number;
  /** Preview window start (seconds) — the chorus. */
  sampleStart: number;
  spec: () => TrackSpec;
}

export const STARTER_SONG_DEFS: StarterSongDef[] = [
  {
    file: 'starter/first-steps.ssc',
    title: 'First Steps',
    bpm: 100,
    bars: 40,
    sampleStart: 28.8,
    spec: firstSteps,
  },
  {
    file: 'starter/neon-circuit.ssc',
    title: 'Neon Circuit',
    bpm: 128,
    bars: 56,
    sampleStart: 45,
    spec: neonCircuit,
  },
  {
    file: 'starter/overdrive.ssc',
    title: 'Overdrive',
    bpm: 162,
    bars: 64,
    sampleStart: 35.6,
    spec: overdrive,
  },
];
