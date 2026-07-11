import { useEffect, useRef, useState } from 'react';
import { GameSession } from '../game/session';
import { isVideoFile, songBpmRange } from '../io/songFiles';
import { roleToColumn } from '../input/controls';
import { difficultyToString } from '../song/difficulty';
import { difficultyColor } from './difficultyUi';
import { TapNoteScore } from '../notes/noteTypes';
import { songKey } from '../app/favorites';
import { chartKey, recordPlay, type ChartScore } from '../app/scores';
import { getIdentity } from '../net/identity';
import { fetchGhost, fetchLeaderboard, submitScore } from '../net/leaderboard';
import type { VersusMatch } from '../net/versusMatch';
import { GhostRace, type GhostInfo } from './GhostRace';
import { OpponentField } from './OpponentField';
import { VersusBar } from './VersusBar';
import { addSongPlay, addSteps } from '../app/stats';
import type { PlayRequest } from './playRequest';
import { useControls } from './useControls';
import { useSettings } from './SettingsContext';

type Phase = 'ready' | 'playing' | 'done' | 'error';

interface Result {
  percent: number;
  grade: string;
  maxCombo: number;
  failed: boolean;
  counts: Record<number, number>;
  best: ChartScore | null;
  isNewRecord: boolean;
  offsets: number[];
}

/** Early/late timing distribution of the just-played taps. */
function OffsetGraph({ offsets }: { offsets: number[] }) {
  if (offsets.length === 0) return null;
  const ms = offsets.map((o) => o * 1000);
  const N = 25;
  const range = 180; // ±180 ms
  const buckets = new Array<number>(N).fill(0);
  for (const m of ms) {
    const idx = Math.round(
      ((Math.max(-range, Math.min(range, m)) + range) / (2 * range)) * (N - 1),
    );
    buckets[idx]++;
  }
  const max = Math.max(1, ...buckets);
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  return (
    <div className="w-[34rem] max-w-full">
      <div className="flex h-24 items-end justify-center gap-[3px]">
        {buckets.map((c, i) => (
          <div
            key={i}
            className={`flex-1 rounded-sm ${i === (N - 1) / 2 ? 'bg-white/40' : 'bg-accent'}`}
            style={{ height: `${Math.max(2, (c / max) * 100)}%`, opacity: 0.35 + 0.65 * (c / max) }}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-[13px] text-muted">
        <span>early</span>
        <span className={mean < -5 ? 'text-[#4b8be6]' : mean > 5 ? 'text-[#ffd94b]' : 'text-ink'}>
          avg {mean >= 0 ? '+' : ''}
          {mean.toFixed(1)} ms {mean < -5 ? '(early)' : mean > 5 ? '(late)' : '(on time)'}
        </span>
        <span>late</span>
      </div>
    </div>
  );
}

const AC = '#ff5d47';
/** How long `back` must be held mid-song to quit (stray taps don't drop out). */
const QUIT_HOLD_MS = 900;

const JUDGMENT_ROWS: Array<[TapNoteScore, string, string]> = [
  [TapNoteScore.W1, 'FANTASTIC', '#38f0ff'],
  [TapNoteScore.W2, 'EXCELLENT', '#ffd23d'],
  [TapNoteScore.W3, 'GREAT', '#59f07f'],
  [TapNoteScore.W4, 'DECENT', '#c86bff'],
  [TapNoteScore.W5, 'WAY OFF', '#ff9d3d'],
  [TapNoteScore.Miss, 'MISS', '#ff5d47'],
];

/** Letter-grade tier colors (gold AAA → red D), matching the judgment palette. */
const GRADE_COLORS: Record<string, string> = {
  AAA: '#ffd23d',
  AA: '#38f0ff',
  A: '#59f07f',
  B: '#5db4ff',
  C: '#ff9d3d',
  D: '#ff5d47',
};
const gradeColor = (g: string): string => GRADE_COLORS[g] ?? '#ececec';

/** Results header: a big tier-colored letter grade beside the % and clear/fail. */
function ResultHeader({ result }: { result: Result }) {
  const gc = gradeColor(result.grade);
  return (
    <>
      <div className="text-[17px] tracking-[0.32em] text-[#ececec]/70">RESULTS</div>
      <div className="my-2 flex items-center gap-9">
        <div
          className="flex min-w-[176px] items-center justify-center border-2 px-8 py-3"
          style={{
            borderColor: gc,
            background: `${gc}0d`,
            boxShadow: `0 0 60px ${gc}44, inset 0 0 34px ${gc}24`,
          }}
        >
          <span
            className="font-black leading-none"
            style={{
              color: gc,
              fontSize: result.grade.length > 2 ? 86 : 118,
              letterSpacing: '0.02em',
              textShadow: `0 0 30px ${gc}aa`,
            }}
          >
            {result.grade}
          </span>
        </div>
        <div className="flex flex-col items-start">
          <div className="text-[74px] font-bold leading-none tabular-nums">
            {(result.percent * 100).toFixed(2)}
            <span className="text-[40px] text-[#ececec]/55">%</span>
          </div>
          <div
            className="mt-2 text-[20px] font-bold tracking-[0.24em]"
            style={{ color: result.failed ? AC : '#59f07f' }}
          >
            {result.failed ? 'FAILED' : 'CLEARED'}
          </div>
        </div>
      </div>
    </>
  );
}

const CTL_BTN =
  'border border-white/15 bg-black/30 px-3 py-1.5 text-[12px] tracking-[0.12em] text-[#ececec]/70 hover:border-[#ff5d47] hover:text-[#ececec]';

/** Live FPS counter (rendered over the playfield). */
function FpsMeter() {
  const [fps, setFps] = useState(0);
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const loop = (t: number) => {
      frames++;
      if (t - last >= 500) {
        setFps(Math.round((frames * 1000) / (t - last)));
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <div className="absolute bottom-4 right-4 z-[3] text-[12px] tracking-[0.12em] text-[#ececec]/45 [font-variant-numeric:tabular-nums]">
      {fps} FPS
    </div>
  );
}

/** Versus standings on the results screen — WIN/LOSE once the rival's result
 *  arrives (the parent re-renders on match updates), waiting/DNF before. */
function VersusOutcome({
  match,
  name,
  yourPercent,
}: {
  match: VersusMatch;
  name: string;
  yourPercent: number;
}) {
  const o = match.opponent;
  if (o.result) {
    const win = yourPercent > o.result.percent;
    const tie = yourPercent === o.result.percent;
    return (
      <div
        className="text-[16px] font-bold tracking-[0.18em]"
        style={{ color: tie ? '#ffd94b' : win ? '#59f07f' : '#ff5d47' }}
      >
        {tie ? 'DRAW' : win ? 'YOU WIN' : `${name} WINS`} · YOU {(yourPercent * 100).toFixed(2)}% —{' '}
        {name} {(o.result.percent * 100).toFixed(2)}%
      </div>
    );
  }
  return (
    <div className="text-[13px] tracking-[0.16em] text-[#ececec]/50">
      {o.left ? `${name} DISCONNECTED` : `WAITING FOR ${name} TO FINISH…`}
    </div>
  );
}

export function Play({ req, onExit }: { req: PlayRequest; onExit: () => void }) {
  const { settings } = useSettings();
  // Versus locks the room's music rate; everything (session, ranking, the
  // results rate note) follows the rate the play actually ran at.
  const effRate = req.versus?.musicRate ?? settings.musicRate;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  // Results screen: ▲▼ chooses between CONTINUE (0) and RETRY (1) on the pad.
  const [doneSel, setDoneSel] = useState(0);
  const doneSelRef = useRef(0);
  doneSelRef.current = doneSel;
  const bgUrlRef = useRef<string | null>(null);
  const bgMediaRef = useRef<HTMLVideoElement | ImageBitmap | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [result, setResult] = useState<Result | null>(null);
  const [loopNum, setLoopNum] = useState(1);
  // Hold-to-quit: `back` held mid-song for QUIT_HOLD_MS exits (with a fill).
  const [quitting, setQuitting] = useState(false);
  const quitTimerRef = useRef<number | null>(null);
  // Bank a session's hit steps into the lifetime counter exactly once —
  // whichever comes first of finishing, retrying, or leaving mid-song.
  const bankedRef = useRef(new WeakSet<GameSession>());
  const bankSteps = (s: GameSession | null) => {
    if (!s || bankedRef.current.has(s)) return;
    bankedRef.current.add(s);
    addSteps(s.stepsTaken);
  };
  // Count a play once per run: guarded so StrictMode's doubled mount effect
  // (which calls start() twice in dev) can't double-count; re-armed on the
  // results screen so RETRY counts as a fresh play.
  const playCountedRef = useRef(false);

  // Versus: re-render on match updates (opponent ready/snaps/finish), and take
  // over the update hook from the versus panel (which has unmounted by now).
  const [, setVsTick] = useState(0);
  const [vsWaiting, setVsWaiting] = useState(false);
  const versusRef = useRef(req.versus);
  versusRef.current = req.versus;
  useEffect(() => {
    const m = req.versus?.match;
    if (!m) return;
    m.onLoadRequested = undefined; // the panel's handoff already ran
    m.onUpdate = () => setVsTick((t) => t + 1);
    return () => {
      m.onUpdate = undefined;
    };
  }, [req.versus]);

  // Stream to the rival while playing: freshly-judged notes (their copy of
  // our playfield) every tick, the scoreboard snap every other tick. Derived
  // stats and display events only — judging never crosses the wire.
  useEffect(() => {
    const m = req.versus?.match;
    if (!m || phase !== 'playing') return;
    // Judgments resolve near-chronologically (misses age via a forward
    // cursor), so a scan pointer over the time-sorted notes finds new ones in
    // O(new). Unjudgable notes (fakes/warped) never resolve — skip them.
    let sent = 0;
    let tick = 0;
    const timer = window.setInterval(() => {
      const s = sessionRef.current;
      if (!s) return;
      const notes = s.judge.notes;
      const fresh: { i: number; tns: number }[] = [];
      while (sent < notes.length) {
        const n = notes[sent];
        if (!n.judgable) {
          sent++;
          continue;
        }
        if (n.tns === TapNoteScore.None) break; // pending — resolves shortly
        fresh.push({ i: sent, tns: n.tns });
        sent++;
      }
      m.sendNotes(fresh);
      if (tick++ % 2 === 0) {
        m.sendSnap({
          atSong: s.songNow,
          percent: Math.max(0, Math.min(1, s.judge.percentDancePoints)),
          combo: s.judge.combo,
          life: s.judge.life,
          failed: s.judge.failed,
        });
      }
    }, 100);
    return () => window.clearInterval(timer);
  }, [phase, req.versus]);

  // Race-the-ghost: the best stored timeline on this board (world best with a
  // ghost, which may be your own PB). Fetched once per song; absent offline.
  // Versus plays race the live rival instead.
  const [ghost, setGhost] = useState<GhostInfo | null>(null);
  useEffect(() => {
    setGhost(null);
    if (req.practice != null || req.versus) return;
    let alive = true;
    const hash = chartKey(req.song, req.chart);
    void (async () => {
      const board = await fetchLeaderboard(hash, settings.musicRate, 10);
      const row = board?.rows.find((r) => r.hasGhost);
      if (!row || !alive) return;
      const frames = await fetchGhost(hash, settings.musicRate, row.playerId);
      if (!frames || frames.length === 0 || !alive) return;
      const mine = row.playerId === getIdentity().playerId;
      setGhost({ frames, name: mine ? 'YOUR BEST' : row.playerName });
    })();
    return () => {
      alive = false;
    };
    // musicRate is fixed for the lifetime of this screen (set on PLAYER
    // OPTIONS beforehand), so req is the only real dependency.
  }, [req, settings.musicRate]);

  const cleanupBg = () => {
    const m = bgMediaRef.current;
    if (m instanceof HTMLVideoElement) {
      m.pause();
      m.removeAttribute('src');
      m.load();
    } else if (m instanceof ImageBitmap) {
      m.close();
    }
    bgMediaRef.current = null;
    if (bgUrlRef.current) {
      URL.revokeObjectURL(bgUrlRef.current);
      bgUrlRef.current = null;
    }
  };

  useEffect(() => {
    const onResize = () => {
      const c = canvasRef.current;
      if (c) sessionRef.current?.resize(c.clientWidth, c.clientHeight);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onResize);
    };
  }, []);

  // Unified input (keyboard + gamepad -> roles, one bus). While playing, the
  // directional roles are note columns: event timestamps ride through to
  // press()/release() untouched so judging stays on the audible axis (keyboard
  // = real event time, gamepad = frame-quantized). On the ready/done overlays,
  // confirm activates the primary button and back exits.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  useControls((e) => {
    if (phaseRef.current === 'playing') {
      // Quit mid-song from the keyboard/gamepad (Escape / pad back) — no mouse,
      // but held (QUIT_HOLD_MS) so a stray press mid-stream can't drop you out.
      if (e.role === 'back') {
        e.nativeEvent?.preventDefault();
        if (e.pressed && !e.repeat && quitTimerRef.current === null) {
          setQuitting(true);
          quitTimerRef.current = window.setTimeout(() => {
            quitTimerRef.current = null;
            if (phaseRef.current === 'playing') onExitRef.current();
          }, QUIT_HOLD_MS);
        } else if (!e.pressed) {
          if (quitTimerRef.current !== null) {
            clearTimeout(quitTimerRef.current);
            quitTimerRef.current = null;
          }
          setQuitting(false);
        }
        return;
      }
      if (e.repeat) return;
      const col = roleToColumn(e.role);
      if (col === undefined) return;
      e.nativeEvent?.preventDefault();
      if (e.pressed) sessionRef.current?.press(col, e.timeStampMs);
      else sessionRef.current?.release(col, e.timeStampMs);
      return;
    }
    if (!e.pressed || e.repeat) return;
    // Results screen: ▲▼ chooses CONTINUE vs RETRY (versus has no RETRY).
    if (phaseRef.current === 'done' && (e.role === 'up' || e.role === 'down')) {
      e.nativeEvent?.preventDefault();
      setDoneSel(versusRef.current ? 0 : e.role === 'up' ? 0 : 1);
      return;
    }
    if (e.role === 'confirm') {
      // A focused button already activates on the native Enter keydown — only
      // route to a button when nothing else will handle it.
      if (e.device === 'keyboard' && document.activeElement?.tagName === 'BUTTON') return;
      e.nativeEvent?.preventDefault();
      (doneSelRef.current === 1 ? retryRef : ctaRef).current?.click();
    } else if (e.role === 'back') {
      e.nativeEvent?.preventDefault();
      onExitRef.current();
    }
  });

  useEffect(
    () => () => {
      bankSteps(sessionRef.current);
      sessionRef.current?.stop();
      cleanupBg();
      if (quitTimerRef.current !== null) clearTimeout(quitTimerRef.current);
    },
    [],
  );

  // Leaving the playing phase (finished / retry) cancels any in-progress quit hold.
  useEffect(() => {
    if (phase !== 'playing' && quitTimerRef.current !== null) {
      clearTimeout(quitTimerRef.current);
      quitTimerRef.current = null;
      setQuitting(false);
    }
  }, [phase]);

  // Ready/done overlays: focus the primary button so Enter/confirm activate it.
  // Entering results resets the selection to CONTINUE.
  useEffect(() => {
    if (phase !== 'playing') ctaRef.current?.focus();
    if (phase === 'done') setDoneSel(0);
  }, [phase]);

  // On the results screen, keep DOM focus on the ▲▼-selected button so a
  // keyboard Enter and a pad confirm both activate the same one.
  useEffect(() => {
    if (phase === 'done') (doneSel === 1 ? retryRef : ctaRef).current?.focus();
  }, [phase, doneSel]);

  const start = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    bankSteps(sessionRef.current);
    sessionRef.current?.stop();
    cleanupBg();
    if (!playCountedRef.current) {
      playCountedRef.current = true;
      addSongPlay(songKey(req.song.displayFullTitle, req.song.artist));
    }

    const session = new GameSession(req.song, req.chart, canvas, {
      scrollMode: settings.scrollMode,
      scrollValue: settings.scrollValue,
      musicRate: effRate,
      audioOffsetMs: settings.audioOffsetMs,
      visualOffsetMs: settings.visualOffsetMs,
      turn: settings.turn,
      reverse: settings.reverse,
      bgMode: settings.bgMode,
      noteSkin: settings.noteSkin,
      practice: req.practice ?? null,
    });
    session.resize(canvas.clientWidth, canvas.clientHeight);
    setLoopNum(1);
    session.onLoop = setLoopNum;
    session.onError = () => {
      if (sessionRef.current === session) setPhase('error');
    };
    session.onEnd = (judge) => {
      bankSteps(session);
      playCountedRef.current = false; // a RETRY from here is a new play
      const counts = { ...judge.tapCounts };
      // Practice runs never reach here (they loop until exit), but make sure a
      // section-only score can never land in the real records. Rate-modded
      // plays aren't comparable to full-speed ones, so they don't count either.
      const unranked = req.practice != null || effRate !== 1;
      const { best, isNewRecord } = unranked
        ? { best: null, isNewRecord: false }
        : recordPlay(req.song, req.chart, {
            percent: judge.percentDancePoints,
            grade: judge.grade,
            maxCombo: judge.maxCombo,
            counts,
          });
      // Online leaderboard (fire-and-forget; queued offline). Practice
      // sections never submit; rate-modded plays do — the server partitions
      // boards by rate, so they land on their own board (never the 1.0x one).
      if (req.practice == null) {
        void submitScore({
          chart: {
            chartHash: chartKey(req.song, req.chart),
            title: req.song.displayFullTitle || 'Untitled',
            artist: req.song.artist,
            stepsType: req.chart.stepsType,
            difficulty: req.chart.difficulty,
            meter: req.chart.meter,
          },
          musicRate: effRate,
          result: {
            percent: judge.percentDancePoints,
            grade: judge.grade,
            maxCombo: judge.maxCombo,
            failed: judge.failed,
            counts,
            holdCounts: { ...judge.holdCounts },
          },
          ...(session.ghostFrames.length > 0 ? { ghost: [...session.ghostFrames] } : {}),
        });
      }
      // Tell the rival how it went; standings render once both results exist.
      req.versus?.match.finish({
        percent: Math.max(0, Math.min(1, judge.percentDancePoints)),
        grade: judge.grade,
        maxCombo: judge.maxCombo,
        failed: judge.failed,
        counts,
        holdCounts: { ...judge.holdCounts },
      });
      setResult({
        percent: judge.percentDancePoints,
        grade: judge.grade,
        maxCombo: judge.maxCombo,
        failed: judge.failed,
        counts,
        best,
        isNewRecord,
        offsets: [...session.offsets],
      });
      setPhase('done');
    };
    sessionRef.current = session;

    // Background image / video (unless the player turned it off).
    if (req.backgroundFile && settings.bgMode !== 'off') {
      if (isVideoFile(req.backgroundFile.name)) {
        const url = URL.createObjectURL(req.backgroundFile);
        bgUrlRef.current = url;
        const v = document.createElement('video');
        v.src = url;
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        bgMediaRef.current = v;
        session.setBackground(v);
      } else {
        // Decode off-thread straight from the File. A detached <img> on a
        // blob URL can be deferred by the browser for seconds (a black field
        // while the song already plays); an ImageBitmap is ready the moment
        // the promise resolves.
        void createImageBitmap(req.backgroundFile)
          .then((bmp) => {
            if (sessionRef.current === session) {
              bgMediaRef.current = bmp;
              session.setBackground(bmp);
            } else {
              bmp.close(); // superseded (StrictMode re-start, retry, exit)
            }
          })
          .catch(() => {
            // Undecodable image — keep the plain dark background.
          });
      }
    }

    if (import.meta.env.DEV) {
      (window as unknown as { __nfSession?: GameSession }).__nfSession = session;
    }
    setResult(null);
    // Keep the LOADING splash up through GPU init + audio decode + prewarm, and
    // reveal the field only once start() has the live loop running. (Flipping to
    // 'playing' up front dropped the splash during the multi-second decode, when
    // the field was still blank / mid-prewarm.) The no-WebGPU and device-lost
    // paths flip us to 'error' via onError — don't stomp that.
    setPhase('ready');
    if (req.versus) {
      // Versus: prepare (GPU + decode), report loaded, and hold until the
      // host's latency-compensated 'go' — both machines begin on one instant.
      const m = req.versus.match;
      m.onGo = (delayMs) => {
        window.setTimeout(() => {
          if (sessionRef.current === session && session.usingGpuRenderer) {
            setVsWaiting(false);
            session.begin();
            setPhase('playing');
          }
        }, delayMs);
      };
      const ok = await session.prepare(req.encodedAudio);
      if (ok && sessionRef.current === session && session.usingGpuRenderer) {
        setVsWaiting(true);
        m.loaded();
      }
      return;
    }
    await session.start(req.encodedAudio);
    if (sessionRef.current === session && session.usingGpuRenderer) {
      setPhase('playing');
    }
  };

  // Straight into the song: START on Player Options already confirmed intent
  // (and is the activating gesture for audio), so there is no second PRESS
  // START gate — the ready splash just covers the load.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    void startRef.current();
  }, []);

  const toggleFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const title = req.song.displayFullTitle || 'Untitled';
  const diffName = difficultyToString(req.chart.difficulty);
  const dcolor = difficultyColor(diffName);
  const r = songBpmRange(req.song);
  const bpmDisp =
    r.max > 0
      ? Math.round(r.min) === Math.round(r.max)
        ? String(Math.round(r.max))
        : `${Math.round(r.min)}–${Math.round(r.max)}`
      : '';

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 overflow-hidden bg-[#050506] font-grotesk [font-variant-numeric:tabular-nums]"
    >
      <div className="relative z-[1] flex h-full w-full">
        <canvas ref={canvasRef} className="block h-full min-w-0 flex-1" />
        {/* Arcade 2P: the rival's live field (their chart, our synced clock),
            split 50/50 like a real cab — the note field is height-constrained,
            so half-width costs the main field nothing on wide screens. The
            panel reserves its space for the whole screen lifetime so the main
            field's canvas never resizes mid-song. */}
        {req.versus?.opponentChart && (
          <div className="h-full min-w-0 flex-1 border-l border-white/10 bg-black/30">
            {phase === 'playing' && sessionRef.current && (
              <OpponentField session={sessionRef.current} versus={req.versus} song={req.song} />
            )}
          </div>
        )}
      </div>

      <div className="absolute bottom-4 left-4 z-[3] flex gap-2">
        <button onClick={toggleFullscreen} title="Fullscreen" className={CTL_BTN}>
          ⛶
        </button>
        <button onClick={onExit} className={CTL_BTN}>
          ← SONGS
        </button>
      </div>

      {phase === 'playing' && <FpsMeter />}

      {phase === 'playing' && quitting && (
        <div className="pointer-events-none absolute inset-0 z-[5] flex items-center justify-center bg-black/35">
          <div className="flex flex-col items-center gap-3 border border-white/15 bg-black/75 px-9 py-6">
            <div className="text-[13px] font-bold tracking-[0.3em] text-[#ececec]/85">
              HOLD TO QUIT
            </div>
            <div className="h-[7px] w-[240px] overflow-hidden rounded-full bg-white/[0.12]">
              <div
                className="h-full w-full origin-left rounded-full"
                style={{
                  backgroundColor: AC,
                  animation: `quitFill ${QUIT_HOLD_MS}ms linear forwards`,
                }}
              />
            </div>
            <div className="text-[11px] tracking-[0.2em] text-[#ececec]/40">
              RELEASE TO KEEP PLAYING
            </div>
          </div>
        </div>
      )}

      {phase === 'playing' && ghost && sessionRef.current && (
        <GhostRace session={sessionRef.current} ghost={ghost} />
      )}

      {phase === 'playing' && req.versus && sessionRef.current && (
        <VersusBar
          session={sessionRef.current}
          match={req.versus.match}
          name={`${req.versus.opponentName} · LV${req.versus.opponentPick.meter}`}
        />
      )}

      {phase === 'playing' && req.practice && (
        <div
          className="absolute right-4 top-4 z-[3] border bg-black/45 px-3 py-1.5 text-[12px] tracking-[0.18em] text-[#ececec]/85"
          style={{ borderColor: AC }}
        >
          PRACTICE · M{Math.floor(req.practice.startBeat / 4) + 1}–M
          {Math.max(1, Math.floor(req.practice.endBeat / 4))} · LOOP {loopNum}
        </div>
      )}

      {phase !== 'playing' && (
        <div
          className="absolute inset-0 z-[2] flex flex-col items-center justify-center gap-3 p-6 text-center text-[#ececec] backdrop-blur-[2px]"
          style={{ background: 'rgba(5,6,8,.82)' }}
        >
          {phase === 'ready' && (
            <>
              <div className="text-[19px] font-bold tracking-[0.22em]">STEPZONE</div>
              <div className="mt-2 text-[40px] font-bold leading-tight">{title}</div>
              <div className="text-[18px] text-[#ececec]/60">
                {req.song.artist || '—'}
                {bpmDisp && ` · BPM ${bpmDisp}`}
              </div>
              <div
                className="mt-1 border px-4 py-1.5 text-[16px] font-bold uppercase tracking-wide"
                style={{ borderColor: dcolor, color: dcolor }}
              >
                {diffName} {req.chart.meter}
              </div>
              <div
                className="mt-4 text-[14px] tracking-[0.22em] text-[#ececec]/60"
                style={{ animation: 'blinkStart 1.4s infinite' }}
              >
                {req.versus && vsWaiting ? `SYNCING WITH ${req.versus.opponentName}…` : 'LOADING…'}
              </div>
            </>
          )}
          {phase === 'error' && (
            <>
              <div className="text-[19px] font-bold tracking-[0.22em]">WEBGPU REQUIRED</div>
              <div className="mt-2 max-w-[440px] text-[15px] leading-relaxed text-[#ececec]/70">
                stepzone renders the note field on WebGPU, which this browser or device doesn&apos;t
                provide. Try a recent Chrome or Edge, or enable hardware acceleration.
              </div>
              <button
                onClick={onExit}
                className="mt-4 border px-4 py-1.5 text-[14px] tracking-[0.18em]"
                style={{ borderColor: AC }}
              >
                ← SONGS
              </button>
            </>
          )}
          {phase === 'done' && result && (
            <>
              <ResultHeader result={result} />
              {req.versus && (
                <VersusOutcome
                  match={req.versus.match}
                  name={`${req.versus.opponentName} (LV${req.versus.opponentPick.meter})`}
                  yourPercent={result.percent}
                />
              )}
              {result.isNewRecord && (
                <div className="text-[14px] font-bold tracking-[0.15em]" style={{ color: AC }}>
                  ★ NEW RECORD
                </div>
              )}
              {effRate !== 1 && (
                <div className="text-[12px] tracking-[0.14em] text-[#ececec]/40">
                  RATE ×{effRate.toFixed(2)} — SCORE NOT SAVED
                </div>
              )}
              <div className="mt-3 w-[400px] max-w-full">
                {JUDGMENT_ROWS.map(([tns, label, color]) => (
                  <div
                    key={tns}
                    className="flex justify-between border-b border-white/[0.06] py-1 text-[18px] tracking-[0.1em]"
                  >
                    <span style={{ color }}>{label}</span>
                    <span className="font-bold tabular-nums">{result.counts[tns] ?? 0}</span>
                  </div>
                ))}
                <div className="flex justify-between border-t border-white/20 py-1 text-[18px] tracking-[0.1em]">
                  <span className="text-[#ececec]/60">MAX COMBO</span>
                  <span className="font-bold tabular-nums">{result.maxCombo}</span>
                </div>
              </div>
              <OffsetGraph offsets={result.offsets} />
              {result.best && (
                <div className="text-[13px] tracking-[0.1em] text-[#ececec]/50">
                  BEST {(result.best.percent * 100).toFixed(2)}% · {result.best.plays} PLAYS
                </div>
              )}
              <div className="mt-3 flex flex-col items-center gap-1.5">
                <button
                  ref={ctaRef}
                  onClick={onExit}
                  className="text-[18px] tracking-[0.22em] outline-none"
                  style={{
                    color: doneSel === 0 ? AC : 'rgba(236,236,236,.45)',
                    animation: doneSel === 0 ? 'blinkStart 1.4s infinite' : undefined,
                  }}
                >
                  CONTINUE
                </button>
                {/* RETRY would need a fresh room handshake in versus — omit it. */}
                {!req.versus && (
                  <button
                    ref={retryRef}
                    onClick={start}
                    className="text-[16px] tracking-[0.18em] outline-none"
                    style={{
                      color: doneSel === 1 ? AC : 'rgba(236,236,236,.45)',
                      animation: doneSel === 1 ? 'blinkStart 1.4s infinite' : undefined,
                    }}
                  >
                    RETRY
                  </button>
                )}
                <div className="mt-1 text-[11px] tracking-[0.16em] text-[#ececec]/35">
                  {req.versus ? 'START — CONTINUE' : '▲▼ SELECT · START — CONFIRM · SELECT — QUIT'}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
