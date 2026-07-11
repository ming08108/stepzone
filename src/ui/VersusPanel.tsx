/**
 * Live-versus setup overlay. Opened two ways: from the song list's SELECT
 * menu with the highlighted song (CREATE or JOIN), or from the pack grid /
 * a ?join= share link with no song context (JOIN only — the room defines the
 * chart, so a joiner never needs to pick one).
 *
 * Everything is pad-operable (skill: pad-controls) AND mouse-clickable:
 *
 *   menu     ▲▼/click CREATE or JOIN, START confirms, SELECT closes
 *   hosting  shows the 6-arrow room code; START/click copies a share link;
 *            SELECT/✕ cancels
 *   enter    press the 6 arrows (or click the arrow pad); SELECT backs out
 *   lobby    both names + ready state; START/click readies; SELECT leaves
 *
 * The panel builds the WebRTC channel (net/versusSignal), runs the lobby over
 * the match controller (net/versusMatch), and when both players are ready
 * hands a versus PlayRequest to the app — gameplay itself lives in Play.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import { chartKey } from '../app/scores';
import { keyboardRole } from '../input/inputBus';
import { resolveBackground } from '../io/bgVideo';
import type { LibraryEntry } from '../io/songFiles';
import { readSongAudio } from '../io/songFiles';
import { getIdentity } from '../net/identity';
import type { ChartRef } from '../net/protocol';
import { CODE_ARROWS, CODE_LENGTH, codeToArrows } from '../net/versus';
import { VersusMatch } from '../net/versusMatch';
import {
  createRoom,
  fetchRoom,
  joinRoom,
  type HostedRoom,
  type VersusConnection,
} from '../net/versusSignal';
import type { Steps } from '../song/steps';
import { bestChartsPerSlot } from './difficultyUi';
import { ensureLoaded, libraryState } from './libraryStore';
import type { PlayRequest } from './playRequest';
import { useSettings } from './SettingsContext';

const AC = '#ff5d47';
const ARROW_GLYPH: Record<string, string> = { L: '←', D: '↓', U: '↑', R: '→' };

type Step =
  | { k: 'menu'; sel: 0 | 1 }
  | { k: 'busy'; message: string }
  | { k: 'hosting'; code: string; copied: boolean }
  | { k: 'enter'; code: string }
  | { k: 'lobby' }
  | { k: 'error'; message: string };

/** Find a chart in the loaded library by content hash (the joiner's lookup).
 *  Lazy catalog entries aren't scanned — open the pack first (documented). */
function findChartByHash(hash: string): { entry: LibraryEntry; chart: Steps } | null {
  for (const entry of libraryState().entries) {
    for (const chart of entry.song.charts) {
      if (chartKey(entry.song, chart) === hash) return { entry, chart };
    }
  }
  return null;
}

export function VersusPanel({
  entry,
  diff,
  initialCode,
  onClose,
  onPlay,
}: {
  /** The highlighted song (hosting context), or null = join-only mode. */
  entry: LibraryEntry | null;
  diff: number;
  /** Room code from a ?join= share link — auto-joins on open. */
  initialCode?: string;
  onClose: () => void;
  onPlay: (r: PlayRequest) => void;
}) {
  const { settings } = useSettings();
  const [step, setStep] = useState<Step>(entry ? { k: 'menu', sel: 0 } : { k: 'enter', code: '' });
  // Re-render on match updates (the match mutates in place).
  const [, setTick] = useState(0);

  const hostedRef = useRef<HostedRoom | null>(null);
  const connRef = useRef<VersusConnection | null>(null);
  const matchRef = useRef<VersusMatch | null>(null);
  // What the handoff needs: host = the highlighted entry; joiner = hash lookup.
  const playSourceRef = useRef<{ entry: LibraryEntry; chart: Steps; musicRate: number } | null>(
    null,
  );
  const handedOffRef = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  // Teardown on unmount — unless the match was handed off to Play.
  useEffect(
    () => () => {
      if (handedOffRef.current) return;
      hostedRef.current?.cancel();
      matchRef.current?.leave();
      connRef.current?.close();
    },
    [],
  );

  const fail = (message: string) => {
    hostedRef.current?.cancel();
    hostedRef.current = null;
    setStep({ k: 'error', message });
  };

  /** Both ready — read the song's files and hand the match to Play. */
  const handoff = async () => {
    const src = playSourceRef.current;
    const match = matchRef.current;
    const connection = connRef.current;
    if (!src || !match || !connection || handedOffRef.current) return;
    handedOffRef.current = true;
    const audio = await readSongAudio(src.entry);
    const bg = await resolveBackground(src.entry);
    onPlay({
      song: src.entry.song,
      chart: src.chart,
      encodedAudio: audio,
      backgroundFile: bg,
      versus: {
        match,
        connection,
        opponentName: match.opponent.name ?? 'RIVAL',
        musicRate: src.musicRate,
        isHost: hostedRef.current !== null,
      },
    });
  };

  /** Wire a fresh data channel to a match controller and enter the lobby. */
  const startMatch = (connection: VersusConnection, isHost: boolean) => {
    connRef.current = connection;
    const match = new VersusMatch(
      {
        send: (d) => connection.channel.send(d),
        close: () => connection.close(),
      },
      { isHost, name: getIdentity().name },
    );
    connection.channel.addEventListener('message', (e) => match.handleMessage(String(e.data)));
    connection.channel.addEventListener('close', () => match.handleClose());
    match.onUpdate = () => {
      if (match.phase === 'done' && !handedOffRef.current) {
        fail('RIVAL LEFT');
        return;
      }
      setTick((t) => t + 1);
    };
    match.onLoadRequested = () => void handoff();
    matchRef.current = match;
    setStep({ k: 'lobby' });
  };

  const host = async () => {
    if (!entry) return; // join-only mode has no chart to host
    setStep({ k: 'busy', message: 'CREATING ROOM…' });
    const loaded = await ensureLoaded(entry);
    const chart = bestChartsPerSlot(loaded.song)[diff];
    if (!chart) {
      fail('NO CHART ON THIS DIFFICULTY');
      return;
    }
    const chartRef: ChartRef = {
      chartHash: chartKey(loaded.song, chart),
      title: loaded.song.displayFullTitle || 'Untitled',
      artist: loaded.song.artist,
      stepsType: chart.stepsType,
      difficulty: chart.difficulty,
      meter: chart.meter,
    };
    const musicRate = settings.musicRate;
    playSourceRef.current = { entry: loaded, chart, musicRate };
    const hosted = await createRoom(getIdentity().name, chartRef, musicRate);
    if (!hosted) {
      fail('VERSUS UNAVAILABLE (SERVER OFFLINE?)');
      return;
    }
    hostedRef.current = hosted;
    setStep({ k: 'hosting', code: hosted.code, copied: false });
    try {
      const connection = await hosted.waitForPeer();
      startMatch(connection, true);
    } catch {
      if (stepRef.current.k === 'hosting') fail('CONNECTION FAILED');
    }
  };

  const join = async (code: string) => {
    setStep({ k: 'busy', message: 'LOOKING UP ROOM…' });
    const room = await fetchRoom(code);
    if (!room) {
      fail('ROOM NOT FOUND (OR EXPIRED)');
      return;
    }
    const local = findChartByHash(room.chart.chartHash);
    if (!local) {
      fail(`CHART NOT IN YOUR LIBRARY — ${room.chart.title}`);
      return;
    }
    playSourceRef.current = { entry: local.entry, chart: local.chart, musicRate: room.musicRate };
    setStep({ k: 'busy', message: `CONNECTING TO ${room.hostName}…` });
    const connection = await joinRoom(code, getIdentity().name, room);
    if (!connection) {
      fail('COULD NOT CONNECT (ROOM TAKEN, OR NAT BLOCKED)');
      return;
    }
    startMatch(connection, false);
  };

  // A ?join= share link goes straight to connecting.
  useEffect(() => {
    if (initialCode) void join(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- actions shared by keys and mouse -------------------------------------------

  const goBack = () => {
    const s = stepRef.current;
    // One level up per press: sub-steps fall back to the menu (when there is
    // one); the menu and the lobby (= leaving the match) close the panel.
    if (s.k === 'menu' || s.k === 'lobby' || s.k === 'busy') onClose();
    else if (s.k === 'hosting' || s.k === 'enter' || s.k === 'error') {
      hostedRef.current?.cancel();
      hostedRef.current = null;
      if (entry) setStep({ k: 'menu', sel: 0 });
      else onClose();
    }
  };

  const chooseMenu = (sel: 0 | 1) => {
    if (sel === 0) void host();
    else setStep({ k: 'enter', code: '' });
  };

  const pressArrow = (a: string) => {
    const s = stepRef.current;
    if (s.k !== 'enter') return;
    const code = s.code + a;
    if (code.length >= CODE_LENGTH) void join(code);
    else setStep({ k: 'enter', code });
  };

  const readyUp = () => {
    matchRef.current?.ready();
    setTick((t) => t + 1);
  };

  const copyShareLink = (code: string) => {
    const url = `${location.origin}/?join=${code}`;
    void navigator.clipboard?.writeText(url).then(
      () => setStep((s) => (s.k === 'hosting' ? { ...s, copied: true } : s)),
      () => {},
    );
  };

  // Pad-first keys — this panel owns the keyboard while open (SongSelect's
  // nav handler is gated off, same pattern as the RANKS panel).
  useEffect(() => {
    const ARROW_KEY: Record<string, string> = {
      ArrowLeft: 'L',
      ArrowDown: 'D',
      ArrowUp: 'U',
      ArrowRight: 'R',
    };
    const onKey = (e: KeyboardEvent) => {
      const role = keyboardRole(e.code);
      const isConfirm = e.key === 'Enter' || role === 'confirm';
      const isBack = e.key === 'Escape' || e.key === 'Shift' || role === 'back';
      const arrow = ARROW_KEY[e.key];
      if (!isConfirm && !isBack && !arrow) return;
      e.preventDefault();
      const s = stepRef.current;
      if (isBack) {
        goBack();
        return;
      }
      if (s.k === 'menu') {
        if (arrow === 'U' || arrow === 'D') setStep({ k: 'menu', sel: s.sel === 0 ? 1 : 0 });
        else if (isConfirm) chooseMenu(s.sel);
      } else if (s.k === 'enter' && arrow) {
        pressArrow(arrow);
      } else if (s.k === 'hosting' && isConfirm) {
        copyShareLink(s.code);
      } else if (s.k === 'lobby' && isConfirm) {
        readyUp();
      } else if (s.k === 'error' && isConfirm) {
        if (entry) setStep({ k: 'menu', sel: 0 });
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const match = matchRef.current;
  const youName = getIdentity().name;

  const hint = (() => {
    switch (step.k) {
      case 'menu':
        return '▲▼ CHOOSE · START — GO · SELECT — CLOSE';
      case 'hosting':
        return 'START — COPY LINK · SELECT — CANCEL';
      case 'enter':
        return 'PRESS THE 6 ARROWS · SELECT — BACK';
      case 'lobby':
        return match?.selfIsReady ? 'WAITING FOR RIVAL…' : 'START — READY · SELECT — LEAVE';
      case 'error':
        return 'START — OK';
      default:
        return '';
    }
  })();

  return (
    <div className="absolute inset-0 z-[30] flex items-center justify-center bg-black/60">
      <div className="flex w-[560px] max-w-[92%] flex-col border border-white/15 bg-[#0b0c0e] shadow-2xl">
        <div className="flex flex-none items-baseline gap-3 border-b border-white/[0.09] px-5 py-3">
          <span className="text-[13px] font-bold tracking-[0.22em]" style={{ color: AC }}>
            VERSUS
          </span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-bold">
            {entry ? entry.song.displayFullTitle || 'Untitled' : 'JOIN A ROOM'}
          </span>
          <button
            onClick={onClose}
            title="Close"
            className="flex-none px-1 text-[15px] text-[#ececec]/40 hover:text-[#ececec]"
          >
            ✕
          </button>
        </div>

        <div className="min-h-[180px] px-6 py-5">
          {step.k === 'menu' && (
            <div className="flex flex-col gap-2">
              {(['CREATE ROOM', 'JOIN WITH CODE'] as const).map((label, i) => (
                <button
                  key={label}
                  onClick={() => chooseMenu(i as 0 | 1)}
                  className="border px-4 py-3 text-left text-[14px] tracking-[0.14em]"
                  style={{
                    borderColor: step.sel === i ? AC : 'rgba(255,255,255,.12)',
                    background: step.sel === i ? AC + '1a' : 'transparent',
                    color: step.sel === i ? '#ececec' : 'rgba(236,236,236,.6)',
                  }}
                >
                  {label}
                </button>
              ))}
              <p className="mt-2 text-[12px] leading-snug text-[#ececec]/40">
                Race a friend live on this chart. One of you creates the room and shares the arrow
                code (or a link); the other joins.
              </p>
            </div>
          )}

          {step.k === 'busy' && (
            <div className="py-10 text-center text-[13px] tracking-[0.16em] text-[#ececec]/60">
              {step.message}
            </div>
          )}

          {step.k === 'hosting' && (
            <div className="flex flex-col items-center gap-3 py-4">
              <div className="text-[12px] tracking-[0.2em] text-[#ececec]/45">ROOM CODE</div>
              <div className="text-[42px] font-bold tracking-[0.18em]" style={{ color: AC }}>
                {codeToArrows(step.code)}
              </div>
              <div className="text-[13px] tracking-[0.14em] text-[#ececec]/60">
                WAITING FOR A RIVAL TO JOIN…
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => copyShareLink(step.code)}
                  className="border px-4 py-1.5 text-[12px] tracking-[0.14em]"
                  style={{ borderColor: AC, color: step.copied ? '#59f07f' : '#ececec' }}
                >
                  {step.copied ? '✓ LINK COPIED' : 'COPY INVITE LINK'}
                </button>
                <button
                  onClick={goBack}
                  className="border border-white/15 px-4 py-1.5 text-[12px] tracking-[0.14em] text-[#ececec]/60 hover:text-[#ececec]"
                >
                  CANCEL
                </button>
              </div>
            </div>
          )}

          {step.k === 'enter' && (
            <div className="flex flex-col items-center gap-3 py-2">
              <div className="text-[12px] tracking-[0.2em] text-[#ececec]/45">ENTER ROOM CODE</div>
              <div className="text-[42px] font-bold tracking-[0.18em]">
                {codeToArrows(step.code)}
                <span className="text-[#ececec]/25">
                  {' · '.repeat(Math.max(0, CODE_LENGTH - step.code.length)).trimEnd()}
                </span>
              </div>
              <div className="flex gap-2">
                {CODE_ARROWS.map((a) => (
                  <button
                    key={a}
                    onClick={() => pressArrow(a)}
                    className="border border-white/15 px-4 py-2 text-[20px] leading-none text-[#ececec]/80 hover:border-[#ff5d47] hover:text-[#ececec]"
                  >
                    {ARROW_GLYPH[a]}
                  </button>
                ))}
              </div>
            </div>
          )}

          {step.k === 'lobby' && match && (
            <div className="flex flex-col gap-2 py-2">
              {[
                { name: youName + ' (YOU)', ready: match.selfIsReady, you: true },
                { name: match.opponent.name ?? '…', ready: match.opponent.ready, you: false },
              ].map((p, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between border border-white/10 px-4 py-3 text-[14px] tracking-[0.1em]"
                >
                  <span>{p.name}</span>
                  {p.you && !p.ready ? (
                    <button
                      onClick={readyUp}
                      className="border px-3 py-1 text-[12px] font-bold tracking-[0.14em]"
                      style={{ borderColor: AC, color: '#ececec' }}
                    >
                      READY UP
                    </button>
                  ) : (
                    <span style={{ color: p.ready ? '#59f07f' : 'rgba(236,236,236,.35)' }}>
                      {p.ready ? 'READY' : 'NOT READY'}
                    </span>
                  )}
                </div>
              ))}
              <p className="mt-1 text-[12px] text-[#ececec]/40">
                The song starts on both machines the moment you are both ready.
              </p>
            </div>
          )}

          {step.k === 'error' && (
            <div className="flex flex-col items-center gap-4 py-6">
              <div className="text-center text-[13px] tracking-[0.14em] text-[#ffd94b]">
                {step.message}
              </div>
              <button
                onClick={() => (entry ? setStep({ k: 'menu', sel: 0 }) : onClose())}
                className="border px-5 py-1.5 text-[12px] tracking-[0.16em]"
                style={{ borderColor: AC }}
              >
                OK
              </button>
            </div>
          )}
        </div>

        <div className="flex flex-none justify-end border-t border-white/[0.09] px-5 py-2">
          <span className="text-[11px] tracking-[0.14em]" style={{ color: AC }}>
            {hint}
          </span>
        </div>
      </div>
    </div>
  );
}
