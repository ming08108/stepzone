/**
 * Dev-only visual harness for the note-field themes. Served by the vite dev
 * server at /harness/theme.html — NOT part of the production build (the build
 * input is index.html only). Mounts the real NoteFieldRenderer on a 1280x720
 * canvas and draws one deterministic representative frame: receptors, taps of
 * 4th/8th/12th/16th quantizations, an active hold, a dropped (grey) hold, a
 * mine, a judgment, a combo, and the gauge.
 *
 * URL params:
 *   ?theme=arcade|itg     noteSkin           (default arcade)
 *   ?judgment=w1|w2|w3|w4|w5|miss|mine|none  (default w1)
 *   ?gauge=0..1           life               (default 0.6; <0.25 = danger)
 *   ?combo=N              combo count        (default 137)
 *   ?reverse=1  ?bare=1   field toggles
 *   ?now=SECONDS          frame time         (default 2.2, BPM 120)
 *   ?failed=1             failed gauge
 */
import '@fontsource/chakra-petch/500.css';
import '@fontsource/chakra-petch/600.css';
import '@fontsource/chakra-petch/700.css';
import '@fontsource/chakra-petch/700-italic.css';
import { Judge } from '../src/gameplay/judge';
import { HoldNoteScore, TapNoteScore } from '../src/notes/noteTypes';
import { parseSimfile } from '../src/parse/loader';
import { NoteFieldRenderer, type Feedback } from '../src/render/noteField';

// One measure of 4ths (two hits + the two hold heads), one 48-row measure
// mixing 4th/8th/12th/16th taps plus a mine and the hold tails, one closer.
const M1: string[] = Array.from({ length: 48 }, () => '0000');
M1[12] = '0100'; // beat 5.00 — 4th
M1[15] = '0010'; // beat 5.25 — 16th
M1[18] = '2100'; // beat 5.50 — 8th + the hold we force-drop below
M1[21] = '00M0'; // beat 5.75 — mine
M1[24] = '0013'; // beat 6.00 — 4th + active-hold tail
M1[28] = '0010'; // beat 6.33 — 12th
M1[30] = '0100'; // beat 6.50 — 8th
M1[33] = '0010'; // beat 6.75 — 16th
M1[36] = '0101'; // beat 7.00 — 4th jump
M1[42] = '0010'; // beat 7.50 — 8th
M1[45] = '3000'; // beat 7.75 — dropped-hold tail

const M2: string[] = Array.from({ length: 16 }, () => '0000');
M2[0] = '1000'; // beat 8.00 — 4th
M2[1] = '0100'; // beat 8.25 — 16th
M2[2] = '0010'; // beat 8.50 — 8th
M2[4] = '0001'; // beat 9.00 — 4th
M2[6] = '1000'; // beat 9.50 — 8th
M2[8] = '0100'; // beat 10.0 — 4th

const SSC = `#VERSION:0.83;
#TITLE:Sector;
#ARTIST:RYOQUCHA;
#MUSIC:none.ogg;
#OFFSET:0.000;
#BPMS:0.000=120.000;
#NOTEDATA:;
#STEPSTYPE:dance-single;
#DIFFICULTY:Expert;
#METER:16;
#NOTES:
1000
0100
0002
0000
,
${M1.join('\n')}
,
${M2.join('\n')}
;`;

const TNS: Record<string, TapNoteScore> = {
  w1: TapNoteScore.W1,
  w2: TapNoteScore.W2,
  w3: TapNoteScore.W3,
  w4: TapNoteScore.W4,
  w5: TapNoteScore.W5,
  miss: TapNoteScore.Miss,
  mine: TapNoteScore.HitMine,
};

async function main(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const skin = q.get('theme') === 'itg' ? 'itg' : 'arcade';
  const judgmentKey = q.get('judgment') ?? 'w1';
  const gauge = Math.max(0, Math.min(1, Number(q.get('gauge') ?? '0.6')));
  const combo = Number(q.get('combo') ?? '137');
  const reverse = q.get('reverse') === '1';
  const bare = q.get('bare') === '1';
  const failed = q.get('failed') === '1';
  const now = Number(q.get('now') ?? '2.2');
  const beat = now * 2; // BPM 120

  const song = parseSimfile(SSC, 'harness.ssc');
  const judge = new Judge(song.charts[0].getNoteData(), song.timing);
  judge.step(0, 0.01, false); // beat 0 tap
  judge.step(1, 0.505, false); // beat 1 tap
  judge.step(3, 1.0, false); // beat 2 — engage the track-3 hold
  judge.update(now, [false, false, false, true]); // track-3 hold engaged + held

  // Force the track-0 hold (head still ahead of the receptors) into the
  // scored-LetGo state the judge produces on a drop, so the grey head +
  // grey body treatment renders.
  const dropped = judge.notes.find((n) => n.track === 0 && n.isHold);
  if (dropped) {
    dropped.holdInitiated = true;
    dropped.holdLife = 0;
    dropped.hns = HoldNoteScore.LetGo;
    dropped.holdResolved = true;
  }

  judge.combo = combo;
  judge.life = gauge;
  judge.failed = failed;
  // Deterministic mid-song score display, independent of the tiny fixture chart.
  Object.defineProperty(judge, 'percentDancePoints', { value: 0.418607 });
  Object.defineProperty(judge, 'grade', { value: 'AA' });

  const tns = TNS[judgmentKey];
  const fb: Feedback = {
    lastJudgment: tns === undefined ? null : { tns, atSeconds: now - 0.06 },
    laneFlash: [-999, now - 0.02, -999, now - 0.2],
    laneHit: [
      null,
      { tns: tns ?? TapNoteScore.W1, atSeconds: now - 0.05 },
      null,
      { tns: TapNoteScore.W2, atSeconds: now - 0.02 },
    ],
  };

  const renderer = new NoteFieldRenderer(4, {
    noteSkin: skin,
    reverse,
    bare,
    songMaxBpm: 120,
    meta: { title: 'Sector', subtitle: 'RYOQUCHA', difficulty: 'EXPERT 16' },
  });
  const canvas = document.getElementById('field') as HTMLCanvasElement;
  renderer.resize(canvas.width, canvas.height, 1);
  const ctx = canvas.getContext('2d')!;

  // Make sure the canvas font faces are actually loaded before drawing.
  await Promise.all([
    document.fonts.load('700 34px "Chakra Petch"'),
    document.fonts.load('italic 700 34px "Chakra Petch"'),
    document.fonts.load('600 16px "Chakra Petch"'),
    document.fonts.load('500 16px "Chakra Petch"'),
  ]).catch(() => undefined);
  await document.fonts.ready;

  renderer.draw(ctx, judge, now, beat, 0.42, fb);

  // ?bench=1 — time many full-frame draws (scrubbing time so notes move and
  // caches face realistic churn) and report avg ms/frame on the page.
  if (q.get('bench') === '1') {
    const frames = 600;
    renderer.draw(ctx, judge, now, beat, 0.42, fb); // warm caches/fonts
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      const t = now + (i % 120) * 0.008; // sweep ~1s of chart time
      renderer.draw(ctx, judge, t, t * 2, 0.42, fb);
    }
    const ms = (performance.now() - t0) / frames;
    const el = document.createElement('div');
    el.style.cssText =
      'position:fixed;top:4px;left:4px;color:#0f0;background:#000;font:14px monospace;padding:2px 6px;z-index:9';
    el.textContent = `bench: ${ms.toFixed(3)} ms/frame`;
    document.body.appendChild(el);
    (window as unknown as { __benchMs: number }).__benchMs = ms;
  }
  (window as unknown as { __ready: boolean }).__ready = true;
}

void main();
