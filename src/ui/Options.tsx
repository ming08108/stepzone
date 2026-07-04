import { type ReactNode, useEffect, useState } from 'react';
import { DEFAULT_KEYBINDINGS, type Settings } from '../app/settings';
import { TURNS } from '../notes/transforms';
import { HidControllerSettings } from './HidControllerSettings';
import { Stage, STEP_AC as AC } from './Stage';
import { useSettings } from './SettingsContext';
import { useMenuNav } from './useMenuNav';

const COLS = [
  { i: 0, label: 'Left', glyph: '←' },
  { i: 1, label: 'Down', glyph: '↓' },
  { i: 2, label: 'Up', glyph: '↑' },
  { i: 3, label: 'Right', glyph: '→' },
];

function keyLabel(code: string): string {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const arrows: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
  };
  return arrows[code] ?? code;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 text-[11px] tracking-[0.2em] text-[#ececec]/40">{title}</div>
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

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className="border px-4 py-1.5 text-[13px] tracking-wide capitalize"
      style={
        active
          ? { borderColor: AC, background: AC + '1a', color: '#ececec' }
          : { borderColor: 'rgba(255,255,255,.15)', color: 'rgba(236,236,236,.55)' }
      }
    >
      {children}
    </button>
  );
}

const val =
  'ml-auto w-[92px] flex-none text-right text-[15px] font-bold [font-variant-numeric:tabular-nums]';
const slider = 'h-1 flex-1 accent-[#ff4d3d]';

export function Options({ onBack, onCalibrate }: { onBack: () => void; onCalibrate: () => void }) {
  const { settings, update } = useSettings();
  const [rebinding, setRebinding] = useState<number | null>(null);
  useMenuNav(onBack);

  useEffect(() => {
    if (rebinding === null) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      if (e.code === 'Escape') return setRebinding(null);
      update({ keybindings: { ...settings.keybindings, [e.code]: rebinding } });
      setRebinding(null);
    };
    window.addEventListener('keydown', onKey, { once: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [rebinding, settings.keybindings, update]);

  const keysFor = (col: number) =>
    Object.entries(settings.keybindings)
      .filter(([, c]) => c === col)
      .map(([code]) => code);
  const clearKey = (code: string) => {
    const kb = { ...settings.keybindings };
    delete kb[code];
    update({ keybindings: kb });
  };

  const mode = settings.scrollMode;
  const isX = mode === 'X';
  const scrollLabel = isX
    ? `${settings.scrollValue.toFixed(2)}×`
    : `${mode}${Math.round(settings.scrollValue)}`;

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
      <div className="h-full overflow-y-auto px-[28px] py-6">
        <div className="mx-auto max-w-[760px]">
          <Section title="SCROLL">
            <Row label="SPEED MOD">
              {(['C', 'X', 'M'] as const).map((m) => (
                <Toggle
                  key={m}
                  active={mode === m}
                  onClick={() => update({ scrollMode: m, scrollValue: m === 'X' ? 2 : 550 })}
                >
                  {m}Mod
                </Toggle>
              ))}
              <input
                type="range"
                min={isX ? 0.5 : 100}
                max={isX ? 8 : 1200}
                step={isX ? 0.25 : 10}
                value={settings.scrollValue}
                onChange={(e) => update({ scrollValue: Number(e.target.value) })}
                className={slider}
              />
              <span className={val}>{scrollLabel}</span>
            </Row>
          </Section>

          <Section title="GAMEPLAY">
            <Row label="MUSIC RATE">
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={settings.musicRate}
                onChange={(e) => update({ musicRate: Number(e.target.value) })}
                className={slider}
              />
              <span className={val}>{settings.musicRate.toFixed(2)}×</span>
            </Row>
            <Row label="TURN">
              {TURNS.map((t) => (
                <Toggle key={t} active={settings.turn === t} onClick={() => update({ turn: t })}>
                  {t}
                </Toggle>
              ))}
            </Row>
            <Row label="SCROLL DIR">
              <Toggle active={!settings.reverse} onClick={() => update({ reverse: false })}>
                Normal
              </Toggle>
              <Toggle active={settings.reverse} onClick={() => update({ reverse: true })}>
                Reverse
              </Toggle>
            </Row>
            <Row label="APPEARANCE">
              {(['visible', 'hidden', 'sudden'] as const).map((a) => (
                <Toggle
                  key={a}
                  active={settings.appearance === a}
                  onClick={() => update({ appearance: a })}
                >
                  {a}
                </Toggle>
              ))}
            </Row>
            <Row label="WEBGPU AURORA">
              <Toggle active={settings.webgpu} onClick={() => update({ webgpu: !settings.webgpu })}>
                {settings.webgpu ? 'On' : 'Off'}
              </Toggle>
              <span className="text-[12px] text-[#ececec]/40">
                beat-reactive GPU shader (no bg image)
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

          <Section title="KEYS">
            <div className="grid grid-cols-4 gap-2">
              {COLS.map(({ i, label, glyph }) => (
                <div key={i} className="border border-white/10 p-3">
                  <div className="text-[12px] tracking-[0.1em] text-[#ececec]/60">
                    {glyph} {label.toUpperCase()}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {keysFor(i).map((code) => (
                      <button
                        key={code}
                        onClick={() => clearKey(code)}
                        title="click to remove"
                        className="border border-white/15 px-1.5 text-[13px] hover:border-[#ff4d3d] hover:text-[#ff4d3d]"
                      >
                        {keyLabel(code)}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setRebinding(i)}
                    className="mt-2 w-full border border-white/10 py-1 text-[12px] tracking-wide text-[#ececec]/60 hover:border-[#ff4d3d] hover:text-[#ececec]"
                  >
                    {rebinding === i ? 'press a key…' : '+ bind'}
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={() => update({ keybindings: { ...DEFAULT_KEYBINDINGS } })}
              className="mt-3 border border-white/10 px-4 py-1.5 text-[12px] tracking-wide text-[#ececec]/60 hover:text-[#ececec]"
            >
              Reset keys to default
            </button>
          </Section>

          <HidControllerSettings />
        </div>
      </div>
    </Stage>
  );
}
