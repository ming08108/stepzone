/**
 * A tiny dance-pad glyph for a steps-type: draws the actual panel layout (single
 * = 4-arrow +, solo = 6, double/couple = two pads, pump = the 5-panel X), so the
 * chart list reads at a glance. Colour is currentColor.
 */
import { columnAnglesFor } from '../render/columns';

const STEPS_TRACKS: Record<string, number> = {
  'dance-single': 4,
  'dance-double': 8,
  'dance-couple': 8,
  'dance-routine': 8,
  'dance-solo': 6,
  'dance-threepanel': 3,
  'pump-single': 5,
  'pump-halfdouble': 6,
  'pump-double': 10,
  'pump-couple': 10,
  'techno-single4': 4,
  'techno-single5': 5,
  'techno-single8': 8,
};

export function tracksForType(stepsType: string): number {
  return STEPS_TRACKS[stepsType] ?? 4;
}

/** "dance-single" -> "Single", "pump-double" -> "Pump Double". */
export function prettyType(stepsType: string): string {
  const [game, mode] = stepsType.split('-');
  const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  return game === 'dance' ? cap(mode ?? game) : `${cap(game)} ${cap(mode ?? '')}`.trim();
}

const S = 7; // panel size
const G = 1.6; // gap between panels
const STEP = S + G;
const PAD_W = 3 * STEP - G; // 3×3 grid
const PAD_GAP = 4;

interface Panel {
  col: number;
  row: number;
  deg: number;
  arrow: boolean;
}

const PUMP_CELLS: Array<[number, number]> = [
  [0, 2],
  [0, 0],
  [1, 1],
  [2, 0],
  [2, 2],
]; // DL, UL, center, UR, DR

function padsFor(stepsType: string, tracks: number): Panel[][] {
  if (stepsType.startsWith('pump')) {
    const one: Panel[] = PUMP_CELLS.map(([col, row]) => ({ col, row, deg: 0, arrow: false }));
    return tracks >= 10 ? [one, one] : [one];
  }
  const fromAngles = (angles: number[]): Panel[] =>
    angles.map((a) => ({
      col: 1 + Math.round(Math.sin(a)),
      row: 1 + Math.round(-Math.cos(a)),
      deg: (a * 180) / Math.PI,
      arrow: true,
    }));
  const angles = columnAnglesFor(stepsType, tracks);
  if (tracks === 8) return [fromAngles(angles.slice(0, 4)), fromAngles(angles.slice(4))];
  return [fromAngles(angles)];
}

export function PadIcon({ stepsType, size = 18 }: { stepsType: string; size?: number }) {
  const pads = padsFor(stepsType, tracksForType(stepsType));
  const width = pads.length * PAD_W + (pads.length - 1) * PAD_GAP;
  return (
    <svg
      viewBox={`0 0 ${width} ${PAD_W}`}
      height={size}
      width={(size * width) / PAD_W}
      aria-hidden="true"
      style={{ flex: 'none' }}
    >
      {pads.map((panels, pi) =>
        panels.map((p, i) => {
          const ox = pi * (PAD_W + PAD_GAP);
          const x = ox + p.col * STEP;
          const y = p.row * STEP;
          const cx = x + S / 2;
          const cy = y + S / 2;
          return (
            <g key={`${pi}-${i}`}>
              <rect x={x} y={y} width={S} height={S} rx={1.6} fill="currentColor" opacity={0.16} />
              {p.arrow ? (
                <polygon
                  points={`${cx},${cy - 2.4} ${cx - 2},${cy + 1.7} ${cx + 2},${cy + 1.7}`}
                  fill="currentColor"
                  opacity={0.95}
                  transform={`rotate(${p.deg} ${cx} ${cy})`}
                />
              ) : (
                <circle cx={cx} cy={cy} r={1.4} fill="currentColor" opacity={0.95} />
              )}
            </g>
          );
        }),
      )}
    </svg>
  );
}
