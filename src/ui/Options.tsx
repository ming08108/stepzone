/**
 * STEPLINE Options — the system/global settings screen: sync & offsets (with
 * auto-calibrate), display, and the unified controls table. Per-play mods
 * (speed, turn, scroll direction, note skin, music rate, background) live on
 * the PLAYER OPTIONS screen before each song — nothing appears on both
 * screens.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Settings } from '../app/settings';
import { dayKey, loadStats } from '../app/stats';
import { HoldNoteScore, TapNoteScore } from '../notes/noteTypes';
import { defaultBindings, type Bindings, type ControlRole } from '../input/controls';
import { connectedPadInfo, pressedGamepadButtons, type PadInfo } from '../input/gamepad';
import { setBindCaptureActive } from '../input/inputBus';
import { getIdentity, setPlayerName } from '../net/identity';
import { DANCER_MODELS } from '../render/dancerModels';
import { Stage, STEP_AC as AC } from './Stage';
import { useSettings } from './SettingsContext';
import { useMenuNav } from './useMenuNav';

/** The one controls table: every role shows (and rebinds) BOTH devices. */
const ROLES: Array<{ role: ControlRole; label: string }> = [
  { role: 'left', label: '← LEFT' },
  { role: 'down', label: '↓ DOWN' },
  { role: 'up', label: '↑ UP' },
  { role: 'right', label: '→ RIGHT' },
  { role: 'confirm', label: '✓ START / CONFIRM' },
  { role: 'back', label: '⤺ SELECT / BACK' },
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
  };
  return named[code] ?? code;
}

function Section({
  title,
  right,
  children,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-8">
      <div className="mb-3 flex items-center gap-4">
        <span className="text-[11px] tracking-[0.2em] text-[#ececec]/55">{title}</span>
        <span className="h-px flex-1 bg-white/[0.09]" />
        {right}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-[52px] items-center gap-5 border border-l-[3px] border-white/10 border-l-transparent px-4 py-2.5">
      <span className="w-[180px] flex-none text-[13px] tracking-[0.12em] text-[#ececec]/85">
        {label}
      </span>
      <div className="flex flex-1 items-center gap-3">{children}</div>
    </div>
  );
}

const val =
  'ml-auto w-[92px] flex-none text-right text-[15px] font-bold [font-variant-numeric:tabular-nums]';
const slider = 'h-1 flex-1 accent-[#ff5d47]';
const chipBtn =
  'border border-white/15 px-1.5 text-[13px] hover:border-[#ff5d47] hover:text-[#ff5d47]';
const bindBtn =
  'border border-white/10 px-2 py-0.5 text-[12px] tracking-wide text-[#ececec]/60 hover:border-[#ff5d47] hover:text-[#ececec]';

// Lifetime-stats display constants. Judgment names/colors mirror Play.tsx's
// JUDGMENT_ROWS (kept as a small local copy so the settings screen doesn't pull
// in the gameplay UI); holds get their own two-outcome row.
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
  const [capture, setCapture] = useState<Capture | null>(null);
  const [pads, setPads] = useState<PadInfo[]>([]);
  // Online display name (net/identity): saved on every keystroke; blur snaps
  // the field back to the normalized (trimmed, defaulted) stored value.
  const [playerName, setPlayerNameState] = useState(() => getIdentity().name);
  // Lifetime stats are read once on entry — they only change during a play, on a
  // different screen, so there's nothing to keep live here. Hidden behind a
  // button so the settings screen leads with the actual settings.
  const [stats] = useState(loadStats);
  const [statsOpen, setStatsOpen] = useState(false);
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
  useMenuNav(onBack);

  const bindings = settings.bindings;
  const setBindings = (b: Bindings) => update({ bindings: b });

  // While capturing, the bus swallows control events so the pressed key/button
  // binds without also driving menu navigation.
  useEffect(() => {
    setBindCaptureActive(capture !== null);
    return () => setBindCaptureActive(false);
  }, [capture]);

  // Live pad list (connects, disconnects AND button presses) — polling is the
  // only reliable source: browsers hide a pad from getGamepads() until it gets
  // a button press, and that appearance doesn't always fire an event.
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

  // Keyboard bind capture: the next keydown binds (Escape cancels). Capture
  // phase + stopPropagation so nothing else in the app reacts to that key.
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

  // Gamepad bind capture: the next newly-pressed button binds (already-held
  // buttons are ignored via the baseline; Escape cancels).
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

  return (
    <Stage
      label="OPTIONS"
      footer={
        <>
          <span>▲▼ SCROLL</span>
          <button onClick={onBack} className="hover:text-[#ececec]">
            SELECT — BACK TO SONGS
          </button>
        </>
      }
    >
      <div className="h-full overflow-y-auto px-[28px] py-8">
        <div className="mx-auto max-w-[760px]">
          <div className="mb-8 border border-l-[3px] border-white/10 border-l-[#ff5d47]/60 px-4 py-2.5 text-[12px] leading-snug tracking-[0.04em] text-[#ececec]/50">
            These settings are system-wide. Play mods — speed, turn, scroll direction, note skin,
            music rate, background — are set per song on the PLAYER OPTIONS screen.
          </div>

          <Section
            title="LIFETIME STATS"
            right={
              <button
                onClick={() => setStatsOpen((o) => !o)}
                className="border px-3 py-1 text-[11px] font-bold tracking-[0.14em]"
                style={{ borderColor: AC, background: AC + '12', color: '#ececec' }}
              >
                {statsOpen ? 'HIDE ▴' : 'VIEW STATS ▸'}
              </button>
            }
          >
            {statsOpen && (
              <>
                <Row label="TOTAL STEPS">
                  <span className="text-[15px] font-bold [font-variant-numeric:tabular-nums] text-[#ececec]">
                    {stats.steps.toLocaleString()}
                  </span>
                </Row>
                <Row label="PLAY TIME">
                  <span className="text-[15px] font-bold [font-variant-numeric:tabular-nums] text-[#ececec]">
                    {formatPlayTime(stats.playTimeSeconds)}
                  </span>
                </Row>
                <Row label="PLAYS">
                  <span className="text-[13px] tracking-[0.06em] text-[#ececec]/85 [font-variant-numeric:tabular-nums]">
                    <span className="font-bold text-[#59f07f]">{stats.songsCompleted}</span> cleared
                    <span className="mx-2 text-[#ececec]/25">/</span>
                    <span className="font-bold text-[#ff5d47]">{stats.songsFailed}</span> failed
                  </span>
                </Row>
                <Row label="BEST COMBO">
                  <span className="text-[15px] font-bold [font-variant-numeric:tabular-nums] text-[#ececec]">
                    {stats.bestCombo.toLocaleString()}
                  </span>
                </Row>
                <Row label="JUDGMENTS">
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
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
                </Row>
                <Row label="STEPS · LAST 14 DAYS">
                  <div className="flex h-[42px] flex-1 items-end gap-[3px]">
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
                            background: d.steps > 0 ? '#ff5d47' : undefined,
                            borderTop: d.steps > 0 ? undefined : '1px solid rgba(255,255,255,0.12)',
                          }}
                        />
                      </div>
                    ))}
                  </div>
                </Row>
              </>
            )}
          </Section>

          <Section title="ONLINE">
            <Row label="PLAYER NAME">
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
            </Row>
          </Section>

          <Section title="SYNC / OFFSET">
            {(
              [
                ['audioOffsetMs', 'AUDIO OFFSET'],
                ['visualOffsetMs', 'VISUAL OFFSET'],
              ] as const
            ).map(([key, label]) => (
              <Row key={key} label={label}>
                <input
                  type="range"
                  min={-150}
                  max={150}
                  step={1}
                  value={settings[key]}
                  onChange={(e) => update({ [key]: Number(e.target.value) } as Partial<Settings>)}
                  className={slider}
                />
                <span className={val}>
                  {settings[key] > 0 ? '+' : ''}
                  {settings[key]} ms
                </span>
              </Row>
            ))}
            <Row label="CALIBRATE">
              <button
                onClick={onCalibrate}
                className="border px-4 py-1.5 text-[13px] tracking-wide"
                style={{ borderColor: AC, background: AC + '1a', color: '#ececec' }}
              >
                Auto-calibrate audio offset ▸
              </button>
            </Row>
          </Section>

          <Section title="DISPLAY">
            <Row label="BENCHMARK">
              <button
                onClick={onBenchmark}
                className="border px-4 py-1.5 text-[13px] tracking-wide"
                style={{ borderColor: AC, background: AC + '1a', color: '#ececec' }}
              >
                Run render benchmark ▸
              </button>
              <span className="text-[12px] text-[#ececec]/55">
                ~40s; measures note-field FPS on this device
              </span>
            </Row>
            <Row label="INPUT TEST">
              <button
                onClick={onInputTest}
                className="border px-4 py-1.5 text-[13px] tracking-wide"
                style={{ borderColor: AC, background: AC + '1a', color: '#ececec' }}
              >
                Test input quantization ▸
              </button>
              <span className="text-[12px] text-[#ececec]/55">
                controller update rate + timing granularity
              </span>
            </Row>
            <Row label="DANCER MODEL">
              <div className="flex flex-wrap gap-2">
                {DANCER_MODELS.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => update({ dancerModel: m.id })}
                    className="border px-3 py-1.5 text-[13px] tracking-wide"
                    style={{
                      borderColor: AC,
                      background: settings.dancerModel === m.id ? AC + '55' : AC + '1a',
                      color: '#ececec',
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              <span className="text-[12px] text-[#ececec]/55">
                the avatar dancing in the attract background (BACKGROUND=DANCE)
              </span>
            </Row>
          </Section>

          <Section title="CONTROLS">
            <div className="mb-2 border border-white/10 px-4 py-2.5 text-[12px] tracking-[0.06em] text-[#ececec]/60">
              {pads.length === 0 ? (
                'No gamepad detected — plug one in and press a button on it. Keyboard always works.'
              ) : (
                <>
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
                        style={
                          p.pressed.length > 0 || p.hotAxes.length > 0 ? { color: AC } : undefined
                        }
                      >
                        {[
                          ...(p.pressed.length > 0 ? [`btn ${p.pressed.join(' ')}`] : []),
                          ...p.hotAxes.map(([i, v]) => `ax${i}:${v > 0 ? '+' : ''}${v}`),
                        ].join('  ') || '·'}
                      </span>
                    </div>
                  ))}
                  <div className="mt-1.5 text-[11px] leading-snug text-[#ececec]/55">
                    Input is read from every pad listed — press a button on each to test. If a
                    plugged-in pad is missing here, the browser hasn't exposed it yet: press a
                    button on it, and check it works on the OS side.
                  </div>
                </>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {ROLES.map(({ role, label }) => {
                const padBtn = bindings.gamepad[role];
                const kbCapturing = capture?.device === 'keyboard' && capture.role === role;
                const gpCapturing = capture?.device === 'gamepad' && capture.role === role;
                return (
                  <div key={role} className="border border-white/10 p-3">
                    <div className="text-[12px] tracking-[0.1em] text-[#ececec]/60">{label}</div>
                    <div className="mt-2 flex flex-wrap items-center gap-1">
                      <span className="w-[34px] flex-none text-[10px] tracking-[0.14em] text-[#ececec]/50">
                        KEYS
                      </span>
                      {keysFor(role).map((code) => (
                        <button
                          key={code}
                          onClick={() => removeKey(code)}
                          title="click to remove"
                          className={chipBtn}
                        >
                          {keyLabel(code)}
                        </button>
                      ))}
                      <button
                        onClick={() =>
                          setCapture(kbCapturing ? null : { role, device: 'keyboard' })
                        }
                        className={bindBtn}
                        style={kbCapturing ? { borderColor: AC, color: AC } : undefined}
                      >
                        {kbCapturing ? 'press a key…' : '+ key'}
                      </button>
                    </div>
                    <div className="mt-2 flex items-center gap-1">
                      <span className="w-[34px] flex-none text-[10px] tracking-[0.14em] text-[#ececec]/50">
                        PAD
                      </span>
                      <span className="text-[12px] text-[#ececec]/80 [font-variant-numeric:tabular-nums]">
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
                        className={bindBtn}
                        style={gpCapturing ? { borderColor: AC, color: AC } : undefined}
                      >
                        {gpCapturing ? 'cancel' : 'bind'}
                      </button>
                      {padBtn != null && (
                        <button
                          onClick={() => clearPadButton(role)}
                          title="clear"
                          className={bindBtn}
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              onClick={() => update({ bindings: defaultBindings() })}
              className="mt-3 border border-white/10 px-4 py-1.5 text-[12px] tracking-wide text-[#ececec]/60 hover:text-[#ececec]"
            >
              Reset all controls to default
            </button>
            <p className="mt-2 text-[12px] text-[#ececec]/40">
              One controls table for every input: each action lists its keyboard key(s) and its
              gamepad button, both rebindable. Standard dpad/stick pads work with no binding; for
              pads whose panels are on other buttons, bind each action here. L-Tek-style pads that
              emit keyboard keys bind under KEYS.
            </p>
          </Section>
        </div>
      </div>
    </Stage>
  );
}
