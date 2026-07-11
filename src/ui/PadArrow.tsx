/**
 * One dance-pad direction arrow for the room-code UI: a filled triangle (the
 * app's ◀▶ arrow language) drawn as a rotated SVG so all four directions are
 * pixel-identical. Unicode arrows ←↓↑→ have different glyph metrics per font
 * (up/down render smaller than left/right), which looked lopsided — one shape
 * rotated by direction fixes it by construction. `dir` is the L/D/U/R room-code
 * letter; the arrow points that way and takes the surrounding text color.
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
        {/* Filled triangle, matching the app's ◀▶ steppers. */}
        <path d="M12 4.5 L20 18.5 L4 18.5 Z" />
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
