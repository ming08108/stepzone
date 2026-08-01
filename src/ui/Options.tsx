/**
 * SYSTEM SETTINGS (design 3a "PANES") — the same rail-pane layout as song
 * select, so the whole app has one navigation model.
 *
 * The regrouped IA, and why:
 *
 *  · TIMING first — this is the game whose whole point is timing accuracy, and
 *    the two offset sliders used to be anonymous ±150 ms ranges with no
 *    feedback loop. The pane now reads the tap errors the engine already
 *    records (app/offsetLog, banked per play) and turns them into a
 *    recommendation — "you hit consistently late, APPLY −21 MS" — with
 *    auto-calibrate kept for a cold start.
 *  · CONTROLS is a full-width table (one row per action, both devices in
 *    aligned columns) with TEST INPUT next to the thing it debugs — binding a
 *    pad is the main reason anyone opens this screen, and it used to come last.
 *  · DISPLAY keeps what changes rendering (benchmark, dancer model).
 *  · PROFILE holds the player name and the lifetime stats, shown open —
 *    stats aren't settings, and they used to occupy the first slot behind a
 *    VIEW STATS disclosure.
 *  · The apology paragraph is gone: the SYSTEM SETTINGS / PLAY MODS boundary
 *    is a segmented control in the header, not prose.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Settings } from '../app/settings';
import { dayKey, loadStats } from '../app/stats';
import { allLoggedOffsets, loadOffsetLog, offsetSuggestion } from '../app/offsetLog';
import { HoldNoteScore, TapNoteScore } from '../notes/noteTypes';
import { defaultBindings, type Bindings, type ControlRole } from '../input/controls';
import { connectedPadInfo, pressedGamepadButtons, type PadInfo } from '../input/gamepad';
import { setBindCaptureActive } from '../input/inputBus';
import { getIdentity, setPlayerName } from '../net/identity';
import { DANCER_MODELS } from '../render/dancerModels';
import { KeyLegend } from './KeyLegend';
import { TimingBar } from './hud/PlayHud';
import { focusStyle } from './songSelectUi';
import { useSettings } from './SettingsContext';
import { useMenuNav } from './useMenuNav';

const AC = '#ff5d47';

const SECTIONS = [
  { id: 'timing', label: 'Timing', glyph: '◷' },
  { id: 'controls', label: 'Controls', glyph: '⌨' },
  { id: 'display', label: 'Display', glyph: '◉' },
  { id: 'profile', label: 'Profile', glyph: '☺' },
] as const;
type SectionId = (typeof SECTIONS)[number]['id'];

/** The one controls table: every role shows (and rebinds) BOTH devices. */
const ROLES: Array<{ role: ControlRole; label: string; glyph: string; glyphColor: string }> = [
  { role: 'left', label: 'Left', glyph: '←', glyphColor: '#ececec' },
  { role: 'down', label: 'Down', glyph: '↓', glyphColor: '#ececec' },
  { role: 'up', label: 'Up', glyph: '↑', glyphColor: '#ececec' },
  { role: 'right', label: 'Right', glyph: '→', glyphColor: '#ececec' },
  { role: 'confirm', label: 'Start / confirm', glyph: '✓', glyphColor: '#59f07f' },
  { role: 'back', label: 'Select / back', glyph: '⤺', glyphColor: '#ff5d47' },
];

function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const named: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Escape: 'Esc',
    Backspace: 'Bksp',
    Slash: '/',
  };
  return named[code] ?? code;
}

const LIFETIME_JUDGMENTS: Array<[TapNoteScore, string, string]> = [
  [TapNoteScore.W1, 'FANTASTIC', '#38f0ff'],
  [TapNoteScore.W2, 'EXCELLENT', '#ffd23d'],
  [TapNoteScore.W3, 'GREAT', '#59f07f'],
  [TapNoteScore.W4, 'DECENT', '#c86bff'],
  [TapNoteScore.W5, 'WAY OFF', '#ff9d3d'],
  [TapNoteScore.Miss, 'MISS', '#ff5d47'],
];

/** Whole-number `Xh Ym` (or `Ym`, or `Ys` under a minute). */
function formatPlayTime(seconds: number): string {
  const total = Math.floor(seconds);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function PaneTitle({
  children,
  sub,
  right,
}: {
  children: string;
  sub?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-4">
      <span className="font-display text-[24px] font-bold tracking-[0.06em]">{children}</span>
      {sub && <span className="max-w-[560px] text-[13px] text-[#ececec]/50">{sub}</span>}
      <span className="h-px min-w-6 flex-1 bg-white/[0.08]" />
      {right}
    </div>
  );
}

function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`border border-white/10 px-5 py-4 ${className}`}>{children}</div>;
}

type Capture = { role: ControlRole; device: 'keyboard' | 'gamepad' };

export function Options({
  onBack,
  onCalibrate,
  onBenchmark,
  onInputTest,
}: {
  onBack: () => void;
  onCalibrate: () => void;
  onBenchmark: () => void;
  onInputTest: () => void;
}) {
  const { settings, update } = useSettings();
  const [section, setSection] = useState<SectionId>('timing');
  const [capture, setCapture] = useState<Capture | null>(null);
  const [pads, setPads] = useState<PadInfo[]>([]);
  const [playerName, setPlayerNameState] = useState(() => getIdentity().name);
  const [stats] = useState(loadStats);
  const offsetLog = useMemo(() => loadOffsetLog(), []);
  const loggedMs = useMemo(() => allLoggedOffsets(offsetLog), [offsetLog]);
  const suggestion = offsetSuggestion(settings.audioOffsetMs, offsetLog);
  useMenuNav(onBack);

  const days = useMemo(() => {
    const out: Array<{ key: string; steps: number }> = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = dayKey(d);
      out.push({ key, steps: stats.dailySteps[key] ?? 0 });
    }
    return out;
  }, [stats]);
  const maxDay = Math.max(1, ...days.map((d) => d.steps));
  const holdsHeld = stats.holds[HoldNoteScore.Held] ?? 0;
  const holdsDropped =
    (stats.holds[HoldNoteScore.LetGo] ?? 0) + (stats.holds[HoldNoteScore.Missed] ?? 0);

  const bindings = settings.bindings;
  const setBindings = (b: Bindings) => update({ bindings: b });

  // While capturing, the bus swallows control events so the pressed key/button
  // binds without also driving menu navigation.
  useEffect(() => {
    setBindCaptureActive(capture !== null);
    return () => setBindCaptureActive(false);
  }, [capture]);

  // Live pad list — polling is the only reliable source (browsers hide a pad
  // from getGamepads() until a button press, without a matching event).
  useEffect(() => {
    let last = '';
    const read = () => {
      const info = connectedPadInfo();
      const key = JSON.stringify(info);
      if (key !== last) {
        last = key;
        setPads(info);
      }
    };
    read();
    const timer = window.setInterval(read, 150);
    return () => window.clearInterval(timer);
  }, []);

  // Keyboard bind capture: the next keydown binds (Escape cancels).
  useEffect(() => {
    if (capture?.device !== 'keyboard') return;
    const role = capture.role;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setCapture(null);
      if (e.code === 'Escape') return;
      setBindings({ ...bindings, keyboard: { ...bindings.keyboard, [e.code]: role } });
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  });

  // Gamepad bind capture: the next newly-pressed button binds.
  useEffect(() => {
    if (capture?.device !== 'gamepad') return;
    const role = capture.role;
    const baseline = new Set(pressedGamepadButtons());
    let raf = 0;
    const poll = () => {
      const pressed = pressedGamepadButtons();
      const fresh = pressed.find((b) => !baseline.has(b));
      if (fresh != null) {
        setCapture(null);
        setBindings({ ...bindings, gamepad: { ...bindings.gamepad, [role]: fresh } });
        return;
      }
      for (const b of [...baseline]) if (!pressed.includes(b)) baseline.delete(b);
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setCapture(null);
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  });

  const keysFor = (role: ControlRole) =>
    Object.entries(bindings.keyboard)
      .filter(([, r]) => r === role)
      .map(([code]) => code);
  const removeKey = (code: string) => {
    const keyboard = { ...bindings.keyboard };
    delete keyboard[code];
    setBindings({ ...bindings, keyboard });
  };
  const clearPadButton = (role: ControlRole) => {
    const gamepad = { ...bindings.gamepad };
    delete gamepad[role];
    setBindings({ ...bindings, gamepad });
  };

  const meanMs = loggedMs.length ? loggedMs.reduce((a, b) => a + b, 0) / loggedMs.length : null;

  const deviceLine = useMemo(() => {
    const gpu = 'gpu' in navigator ? 'WebGPU' : 'no WebGPU';
    const m = /(Edg|Chrome|Firefox)\/(\d+)/.exec(navigator.userAgent);
    const browser = m ? `${m[1] === 'Edg' ? 'Edge' : m[1]} ${m[2]}` : 'This browser';
    return `${browser} · ${gpu}`;
  }, []);

  const smallBtn =
    'flex h-[28px] items-center px-3 font-display text-[12px] font-bold tracking-[0.1em]';

  /* ── panes ────────────────────────────────────────────────────────────── */

  const timingPane = (
    <div className="flex flex-wrap gap-8">
      <div className="flex w-[680px] max-w-full flex-none flex-col gap-[16px]">
        <PaneTitle sub="The clock runs off the audio context and input is stamped at the event. These two numbers correct for the lag your hardware adds on top.">
          TIMING
        </PaneTitle>

        {(
          [
            [
              'audioOffsetMs',
              'AUDIO OFFSET',
              'Moves when the game thinks the sound happened. Negative judges earlier — use it if you hit in time with the music but score late.',
            ],
            [
              'visualOffsetMs',
              'VISUAL OFFSET',
              'Moves the arrows only, never the judgment. Use it if the arrows look out of step with the beat you hear.',
            ],
          ] as const
        ).map(([key, label, help]) => {
          const v = settings[key];
          const suggest = key === 'audioOffsetMs' && suggestion ? suggestion.suggestMs : null;
          return (
            <Card key={key}>
              <div className="flex items-baseline gap-[14px]">
                <span className="font-display text-[14px] font-bold tracking-[0.12em]">
                  {label}
                </span>
                <span className="flex-1" />
                <span className="font-display text-[28px] leading-none font-bold tabular-nums">
                  {v > 0 ? '+' : ''}
                  {v}
                </span>
                <span className="text-[13px] text-[#ececec]/45">ms</span>
              </div>
              <div className="relative mt-[16px]">
                <div className="pointer-events-none absolute -top-[4px] -bottom-[4px] left-1/2 w-px bg-white/30" />
                {suggest != null && (
                  <div
                    className="pointer-events-none absolute -top-[8px] h-[22px] w-[2px] bg-[#59f07f]"
                    style={{ left: `${((suggest + 150) / 300) * 100}%` }}
                    title={`suggested ${suggest} ms`}
                  />
                )}
                <input
                  type="range"
                  min={-150}
                  max={150}
                  step={1}
                  value={v}
                  onChange={(e) => update({ [key]: Number(e.target.value) } as Partial<Settings>)}
                  className="h-1 w-full accent-[#ff5d47]"
                />
              </div>
              <div className="mt-1 flex justify-between text-[11px] tracking-[0.1em] text-[#ececec]/35">
                <span>−150</span>
                <span>−75</span>
                <span>0</span>
                <span>+75</span>
                <span>+150</span>
              </div>
              <div className="mt-[10px] text-[13px] leading-[1.5] text-[#ececec]/60">{help}</div>
            </Card>
          );
        })}

        <div
          className="flex items-center gap-[18px] px-5 py-4"
          style={{ border: '1px solid rgba(255,93,71,.4)', background: 'rgba(255,93,71,.06)' }}
        >
          <div className="flex-1">
            <div className="font-display text-[14px] font-bold tracking-[0.1em]">
              AUTO-CALIBRATE
            </div>
            <div className="mt-[3px] text-[13px] text-[#ececec]/60">
              Tap along to a metronome. Measures and sets your audio offset for you.
            </div>
          </div>
          <button
            onClick={onCalibrate}
            className="flex h-[44px] items-center px-[22px] font-display text-[14px] font-bold tracking-[0.14em]"
            style={{ background: AC, color: '#0b0c0e' }}
          >
            START ▸
          </button>
        </div>
      </div>

      <div className="flex w-[380px] max-w-full flex-none flex-col gap-[16px] pt-[52px]">
        <Card className="bg-[#0e0f12]">
          <div className="flex items-baseline gap-[10px]">
            <span className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
              YOUR LAST {offsetLog.length || 0} PLAYS
            </span>
            <span className="h-px flex-1 bg-white/[0.07]" />
            <span className="text-[11px] text-[#ececec]/35 tabular-nums">
              {loggedMs.length} taps
            </span>
          </div>
          {loggedMs.length > 0 ? (
            <>
              <div className="mt-3">
                <TimingBar recentMs={loggedMs.slice(-60)} meanMs={meanMs} k={0.72} />
              </div>
              {suggestion ? (
                <>
                  <div className="mt-[12px] text-[13px] leading-[1.5] text-[#ececec]/70">
                    You hit consistently {suggestion.meanMs > 0 ? 'late' : 'early'}. Nudging audio
                    offset to{' '}
                    <span className="font-bold text-[#59f07f]">{suggestion.suggestMs} ms</span>{' '}
                    would centre you.
                  </div>
                  <button
                    onClick={() => update({ audioOffsetMs: suggestion.suggestMs })}
                    className="mt-3 flex h-[38px] w-full items-center justify-center font-display text-[13px] font-bold tracking-[0.12em] text-[#59f07f]"
                    style={{ boxShadow: 'inset 0 0 0 1px #59f07f' }}
                  >
                    APPLY {suggestion.suggestMs} MS
                  </button>
                </>
              ) : (
                <div className="mt-[12px] text-[13px] leading-[1.5] text-[#ececec]/55">
                  {meanMs != null && Math.abs(meanMs) <= 5
                    ? 'You are centred — nothing to fix.'
                    : 'Play a little more for a reliable read.'}
                </div>
              )}
            </>
          ) : (
            <div className="mt-3 text-[13px] leading-[1.5] text-[#ececec]/50">
              Finish a few songs and your tap errors land here, with a concrete suggestion when they
              drift.
            </div>
          )}
        </Card>

        <Card className="bg-[#0e0f12]">
          <div className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">
            WHICH IS WHICH
          </div>
          <div className="mt-[10px] flex flex-col gap-[10px] text-[13px] leading-[1.5] text-[#ececec]/60">
            <div>
              <span className="font-bold text-[#ececec]">Audio offset</span> moves when the game
              thinks the sound happened. Change it if you hit in time with the music but score early
              or late.
            </div>
            <div>
              <span className="font-bold text-[#ececec]">Visual offset</span> moves the arrows only.
              Change it if the arrows look off from the beat you hear.
            </div>
          </div>
        </Card>
      </div>
    </div>
  );

  const controlsPane = (
    <div className="flex max-w-[1160px] flex-col gap-[14px]">
      <PaneTitle
        sub={
          pads.length === 0
            ? 'No gamepad detected — press a button on one to wake it. Keyboard always works.'
            : undefined
        }
        right={
          <div className="flex gap-2">
            <button
              onClick={onInputTest}
              className={smallBtn}
              style={{
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.18)',
                color: 'rgba(236,236,236,.75)',
              }}
            >
              TEST INPUT ▸
            </button>
            <button
              onClick={() => update({ bindings: defaultBindings() })}
              className={smallBtn}
              style={{ color: 'rgba(236,236,236,.45)' }}
            >
              RESET ↺
            </button>
          </div>
        }
      >
        CONTROLS
      </PaneTitle>

      {pads.length > 0 && (
        <div className="border border-white/10 px-4 py-2.5 text-[12px] tracking-[0.06em] text-[#ececec]/60">
          {pads.map((p) => (
            <div key={p.index} className="flex items-baseline gap-3">
              <span className="flex-none text-[#ececec]/50">#{p.index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[#ececec]/80">
                {p.id}
                {p.mapping !== 'standard' && (
                  <span className="ml-2 text-[10px] tracking-[0.1em] text-[#ffcf3d]/70">
                    UNMAPPED LAYOUT — BIND BELOW
                  </span>
                )}
              </span>
              <span
                className="flex-none [font-variant-numeric:tabular-nums]"
                style={p.pressed.length > 0 || p.hotAxes.length > 0 ? { color: AC } : undefined}
              >
                {[
                  ...(p.pressed.length > 0 ? [`btn ${p.pressed.join(' ')}`] : []),
                  ...p.hotAxes.map(([i, v]) => `ax${i}:${v > 0 ? '+' : ''}${v}`),
                ].join('  ') || '·'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="border border-white/10">
        <div className="grid h-[30px] grid-cols-[220px_1fr_260px] items-center gap-5 border-b border-white/[0.08] px-[18px] font-display text-[10px] tracking-[0.2em] text-[#ececec]/35">
          <span>ACTION</span>
          <span>KEYBOARD</span>
          <span>GAMEPAD</span>
        </div>
        {ROLES.map(({ role, label, glyph, glyphColor }) => {
          const padBtn = bindings.gamepad[role];
          const kbCapturing = capture?.device === 'keyboard' && capture.role === role;
          const gpCapturing = capture?.device === 'gamepad' && capture.role === role;
          return (
            <div
              key={role}
              className="grid min-h-[46px] grid-cols-[220px_1fr_260px] items-center gap-5 border-b border-white/[0.05] px-[18px] py-1"
            >
              <span className="flex items-center gap-[10px] text-[14px]">
                <span className="w-[18px] text-center" style={{ color: glyphColor }}>
                  {glyph}
                </span>
                <span>{label}</span>
              </span>
              <span className="flex flex-wrap items-center gap-[6px]">
                {keysFor(role).map((code) => (
                  <button
                    key={code}
                    onClick={() => removeKey(code)}
                    title="click to remove"
                    className="inline-flex h-6 min-w-[32px] items-center justify-center border border-white/[0.18] px-2 font-display text-[12px] hover:border-[#ff5d47] hover:text-[#ff5d47]"
                  >
                    {keyLabel(code)}
                  </button>
                ))}
                <button
                  onClick={() => setCapture(kbCapturing ? null : { role, device: 'keyboard' })}
                  className="inline-flex h-6 items-center border border-dashed border-white/[0.16] px-2 text-[12px] text-[#ececec]/45 hover:border-[#ff5d47] hover:text-[#ececec]"
                  style={kbCapturing ? { borderColor: AC, color: AC } : undefined}
                >
                  {kbCapturing ? 'press a key…' : '+ add'}
                </button>
              </span>
              <span className="flex items-center gap-[10px]">
                <span className="text-[13px] text-[#ececec]/60 [font-variant-numeric:tabular-nums]">
                  {gpCapturing ? (
                    <span style={{ color: AC }}>press a button…</span>
                  ) : padBtn != null ? (
                    `Button ${padBtn}`
                  ) : (
                    'default'
                  )}
                </span>
                <span className="flex-1" />
                <button
                  onClick={() => setCapture(gpCapturing ? null : { role, device: 'gamepad' })}
                  className="inline-flex h-6 items-center border border-white/[0.14] px-[10px] text-[12px] tracking-[0.06em] text-[#ececec]/60 hover:border-[#ff5d47] hover:text-[#ececec]"
                  style={gpCapturing ? { borderColor: AC, color: AC } : undefined}
                >
                  {gpCapturing ? 'cancel' : 'bind'}
                </button>
                {padBtn != null && (
                  <button
                    onClick={() => clearPadButton(role)}
                    title="clear"
                    className="inline-flex h-6 items-center border border-white/[0.14] px-2 text-[12px] text-[#ececec]/60 hover:border-[#ff5d47]"
                  >
                    ✕
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      <p className="text-[12px] leading-snug text-[#ececec]/40">
        One controls table for every input: each action lists its keyboard key(s) and its gamepad
        button, both rebindable. Standard dpad/stick pads work with no binding; L-Tek-style pads
        that emit keyboard keys bind under KEYBOARD.
      </p>
    </div>
  );

  const displayPane = (
    <div className="flex max-w-[900px] flex-col gap-[16px]">
      <PaneTitle>DISPLAY</PaneTitle>
      <Card>
        <div className="flex items-center gap-[18px]">
          <div className="flex-1">
            <div className="font-display text-[14px] font-bold tracking-[0.1em]">
              RENDER BENCHMARK
            </div>
            <div className="mt-[3px] text-[13px] text-[#ececec]/60">
              ~40s; measures note-field FPS on this device, right where it matters.
            </div>
          </div>
          <button
            onClick={onBenchmark}
            className="flex h-[40px] items-center px-[18px] font-display text-[13px] font-bold tracking-[0.12em]"
            style={{ boxShadow: `inset 0 0 0 1px ${AC}80`, color: AC }}
          >
            RUN ▸
          </button>
        </div>
      </Card>
      <Card>
        <div className="font-display text-[14px] font-bold tracking-[0.1em]">DANCER MODEL</div>
        <div className="mt-[3px] text-[13px] text-[#ececec]/60">
          The avatar dancing in the DANCE background.
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          {DANCER_MODELS.map((m) => {
            const on = settings.dancerModel === m.id;
            return (
              <button
                key={m.id}
                onClick={() => update({ dancerModel: m.id })}
                className="px-4 py-2 font-display text-[13px] tracking-[0.06em]"
                style={
                  on
                    ? { ...focusStyle(true), fontWeight: 700 }
                    : {
                        boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.14)',
                        color: 'rgba(236,236,236,.7)',
                      }
                }
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </Card>
    </div>
  );

  const profilePane = (
    <div className="flex max-w-[900px] flex-col gap-[16px]">
      <PaneTitle>PROFILE</PaneTitle>
      <Card>
        <div className="flex flex-wrap items-center gap-4">
          <span className="w-[150px] font-display text-[13px] tracking-[0.12em] text-[#ececec]/85">
            PLAYER NAME
          </span>
          <input
            type="text"
            maxLength={24}
            value={playerName}
            onChange={(e) => {
              setPlayerNameState(e.target.value);
              setPlayerName(e.target.value);
            }}
            onBlur={() => setPlayerNameState(getIdentity().name)}
            className="w-[220px] border border-white/[0.14] bg-transparent px-[10px] py-[6px] text-[14px] tracking-[0.04em] text-[#ececec] outline-none focus:border-[#ff5d47]"
          />
          <span className="text-[12px] text-[#ececec]/55">
            shown on online leaderboards; renames apply from your next play
          </span>
        </div>
      </Card>

      <Card>
        <div className="font-display text-[10px] tracking-[0.24em] text-[#ececec]/35">LIFETIME</div>
        <div className="mt-3 grid grid-cols-4 gap-px bg-white/[0.07]">
          {(
            [
              ['TOTAL STEPS', stats.steps.toLocaleString(), ''],
              ['PLAY TIME', formatPlayTime(stats.playTimeSeconds), ''],
              ['PLAYS', `${stats.songsCompleted} / ${stats.songsFailed}`, 'cleared / failed'],
              ['BEST COMBO', stats.bestCombo.toLocaleString(), ''],
            ] as const
          ).map(([label, value, note]) => (
            <div key={label} className="bg-[#0b0c0e] px-4 py-3">
              <div className="text-[10px] tracking-[0.18em] text-[#ececec]/35">{label}</div>
              <div className="mt-1 font-display text-[22px] font-bold tabular-nums">{value}</div>
              {note && <div className="text-[11px] text-[#ececec]/40">{note}</div>}
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {LIFETIME_JUDGMENTS.map(([tns, label, color]) => (
            <span key={tns} className="text-[12px] tracking-[0.08em]">
              <span style={{ color }}>{label}</span>{' '}
              <span className="font-bold text-[#ececec]/85 [font-variant-numeric:tabular-nums]">
                {(stats.taps[tns] ?? 0).toLocaleString()}
              </span>
            </span>
          ))}
          <span className="text-[12px] tracking-[0.08em]">
            <span className="text-[#ececec]/55">HOLDS</span>{' '}
            <span className="font-bold text-[#ececec]/85 [font-variant-numeric:tabular-nums]">
              {holdsHeld.toLocaleString()}
            </span>
            <span className="text-[#ececec]/50">/{holdsDropped.toLocaleString()}</span>
          </span>
        </div>

        <div className="mt-4">
          <div className="mb-1 text-[10px] tracking-[0.18em] text-[#ececec]/35">
            STEPS · LAST 14 DAYS
          </div>
          <div className="flex h-[42px] items-end gap-[3px]">
            {days.map((d) => (
              <div
                key={d.key}
                title={`${d.key} — ${d.steps.toLocaleString()} steps`}
                className="flex h-full flex-1 items-end"
              >
                <div
                  className="w-full"
                  style={{
                    height: `${Math.max(d.steps > 0 ? 6 : 2, (d.steps / maxDay) * 100)}%`,
                    background: d.steps > 0 ? AC : undefined,
                    borderTop: d.steps > 0 ? undefined : '1px solid rgba(255,255,255,0.12)',
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  );

  const panes: Record<SectionId, ReactNode> = {
    timing: timingPane,
    controls: controlsPane,
    display: displayPane,
    profile: profilePane,
  };

  return (
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-[#0b0c0e] font-grotesk text-[#ececec] [font-variant-numeric:tabular-nums]">
      {/* Header: the boundary with PLAY MODS, named instead of apologized for */}
      <div className="flex h-[64px] flex-none items-center gap-6 border-b border-white/[0.09] bg-[#0e0f12] px-6">
        <span className="font-display text-[20px] font-bold tracking-[0.22em]">STEPZONE</span>
        <div
          className="flex h-[32px]"
          style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.12)' }}
        >
          <span
            className="flex items-center px-4 font-display text-[13px] font-bold tracking-[0.1em]"
            style={{ background: AC, color: '#0b0c0e' }}
          >
            SYSTEM SETTINGS
          </span>
          <span
            className="flex items-center px-4 font-display text-[13px] tracking-[0.1em] text-[#ececec]/55"
            title="Play mods — speed, turn, note skin, background — open before each song"
          >
            PLAY MODS ▸
          </span>
        </div>
        <span className="flex-1" />
        <span className="font-display text-[12px] tracking-[0.12em] text-[#ececec]/50">
          SAVED AUTOMATICALLY
        </span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* The rail — same layout, same focus treatment as song select */}
        <div className="flex w-[264px] flex-none flex-col border-r border-white/[0.09] bg-[#0e0f12]">
          <div className="px-[18px] pt-[18px] pb-2 font-display text-[11px] tracking-[0.24em] text-[#ececec]/35">
            SETTINGS
          </div>
          <div className="flex flex-col px-[10px]">
            {SECTIONS.map((s) => {
              const on = section === s.id;
              const note =
                s.id === 'controls'
                  ? pads.length === 0
                    ? 'no pad'
                    : `${pads.length} pad${pads.length === 1 ? '' : 's'}`
                  : '';
              return (
                <button
                  key={s.id}
                  onClick={() => setSection(s.id)}
                  className="flex h-[44px] items-center gap-[10px] pr-3 pl-[9px] text-left"
                  style={{ ...focusStyle(on), color: on ? '#fff' : 'rgba(236,236,236,.72)' }}
                >
                  <span
                    className="w-4 text-center"
                    style={{ color: on ? AC : 'rgba(236,236,236,.4)' }}
                  >
                    {s.glyph}
                  </span>
                  <span className="flex-1 text-[14px]" style={{ fontWeight: on ? 700 : 400 }}>
                    {s.label}
                  </span>
                  {note && <span className="text-[12px] text-[#ececec]/35">{note}</span>}
                </button>
              );
            })}
          </div>
          <span className="flex-1" />
          <div className="px-[18px] pb-[18px]">
            <div className="mb-2 font-display text-[10px] tracking-[0.24em] text-[#ececec]/30">
              THIS DEVICE
            </div>
            <div className="text-[12px] leading-[1.6] text-[#ececec]/45">{deviceLine}</div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-10 py-7">{panes[section]}</div>
      </div>

      <KeyLegend
        actions={{
          updown: 'SETTING',
          leftright: 'ADJUST',
          select: 'BACK TO SONGS',
          start: 'ACTIVATE',
          fav: null,
        }}
      />
    </div>
  );
}
