/**
 * One dance-pad direction arrow for the room-code UI, drawn as a rotated SVG so
 * all four directions are pixel-identical. The Unicode arrows ←↓↑→ have
 * different glyph metrics per font (up/down render smaller than left/right),
 * which looked lopsided in the code display — one shape rotated by direction
 * fixes it by construction. `dir` is the L/D/U/R room-code letter; the arrow
 * points that way and takes the surrounding text color (currentColor).
 */

/** Rotation (deg) that makes the base up-arrow point in each direction. */
const ROTATION: Record<string, number> = { U: 0, R: 90, D: 180, L: 270 };
const LABEL: Record<string, string> = { L: 'left', D: 'down', U: 'up', R: 'right' };

export function PadArrow({
  dir,
  size = 22,
  className,
}: {
  dir: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      data-arrow={dir}
      role="img"
      aria-label={LABEL[dir] ?? dir}
      className={className}
      style={{
        display: 'inline-flex',
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ transform: `rotate(${ROTATION[dir] ?? 0}deg)`, display: 'block' }}
      >
        <path d="M12 2.5 L19.5 11 L14.5 11 L14.5 21.5 L9.5 21.5 L9.5 11 L4.5 11 Z" />
      </svg>
    </span>
  );
}

/** A room code rendered as a row of uniform arrows, with an accessible label. */
export function CodeArrows({
  code,
  size = 22,
  gap = 8,
}: {
  code: string;
  size?: number;
  gap?: number;
}) {
  return (
    <span
      className="inline-flex items-center"
      style={{ gap }}
      aria-label={[...code].map((d) => LABEL[d] ?? d).join(' ')}
    >
      {[...code].map((d, i) => (
        <PadArrow key={i} dir={d} size={size} />
      ))}
    </span>
  );
}
