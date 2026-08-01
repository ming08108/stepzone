import { useEffect, useMemo, useRef, useState } from 'react';
import { GameSession } from '../game/session';
import { Judge } from '../gameplay/judge';
import { DEFAULT_WINDOWS } from '../gameplay/windows';
import { buildAttractConfig } from '../render/attractConfig';
import { columnAnglesFor } from '../render/columns';
import type { Feedback } from '../render/fieldConfig';
import { isVideoFile } from '../io/songFiles';
import { roleToColumn } from '../input/controls';
import { connectedPadInfo } from '../input/gamepad';
import { looksLikeDancePad } from '../input/padDetect';
import { difficultyToString } from '../song/difficulty';
import { TapNoteScore } from '../notes/noteTypes';
import { songKey } from '../app/favorites';
import { chartKey, loadScores, recordPlay } from '../app/scores';
import { submitScore } from '../net/leaderboard';
import { type PlayResult, type ReplayEvent, type SubmitInput } from '../net/protocol';
import { chartDataOf } from '../song/chartData';
import { RoomStandings } from './RoomRace';
import { addSongPlay, addSteps, recordPlayEnd } from '../app/stats';
import type { PlayRequest } from './playRequest';
import { roomState, subscribeRoom } from './roomStore';
import { useControls } from './useControls';
import { useSettings } from './SettingsContext';
import { useSyncExternalStore } from 'react';
import { PlayHud } from './hud/PlayHud';
import { useHudTelemetry } from './hud/useHudTelemetry';
import { LoadingSplash } from './LoadingSplash';
import { Results, type Result } from './Results';
import { recordPlayOffsets } from '../app/offsetLog';

type Phase = 'ready' | 'playing' | 'done' | 'error';

const AC = '#ff5d47';
/** How long `back` must be held mid-song to quit (stray taps don't drop out). */
const QUIT_HOLD_MS = 900;

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

export function Play({ req, onExit }: { req: PlayRequest; onExit: () => void }) {
  const { settings } = useSettings();
  // The DOM HUD samples the live session at 15 Hz (solo only — in versus the
  // column it occupies is where 2P's field renders).
  const [hudFps, setHudFps] = useState(0);
  // Your stored best on this chart before the CURRENT run (re-read on every
  // start, so a RETRY after a new record compares against the fresh best).
  const [pbPercent, setPbPercent] = useState<number | null>(() => {
    const rec = loadScores()[chartKey(req.song, req.chart)];
    return rec ? rec.percent : null;
  });
  const numTracks = useMemo(() => req.chart.getNoteData().numTracks, [req.chart]);
  // Versus locks the room's music rate; everything (session, ranking, the
  // results rate note) follows the rate the play actually ran at.
  const effRate = req.versus?.musicRate ?? settings.musicRate;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sessionRef = useRef<GameSession | null>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);
  const watchReplayRef = useRef<HTMLButtonElement>(null);
  // Results screen: ▲▼ moves through CONTINUE (0) / RETRY (1) / WATCH REPLAY (2)
  // on the pad. RETRY + WATCH REPLAY exist for solo, non-replay plays only.
  const [doneSel, setDoneSel] = useState(0);
  const doneSelRef = useRef(0);
  doneSelRef.current = doneSel;
  const bgUrlRef = useRef<string | null>(null);
  const bgMediaRef = useRef<HTMLVideoElement | ImageBitmap | null>(null);
  const [phase, setPhase] = useState<Phase>('ready');
  const [result, setResult] = useState<Result | null>(null);
  const [loopNum, setLoopNum] = useState(1);
  // Pre-song splash progress (GameSession.onLoadStage milestones).
  const [loadStage, setLoadStage] = useState({ stage: 'PREPARING', frac: 0.05 });
  const telemetry = useHudTelemetry(sessionRef, phase === 'playing');
  // FPS readout for the HUD's bottom strip (the old FpsMeter loop, hoisted).
  useEffect(() => {
    if (phase !== 'playing') return;
    let raf = 0;
    let frames = 0;
    let last = performance.now();
    const loop = (t: number) => {
      frames++;
      if (t - last >= 500) {
        setHudFps(Math.round((frames * 1000) / (t - last)));
        frames = 0;
        last = t;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [phase]);
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
  // Which devices produced NOTE inputs this run (menu keys ignored). A keyboard
  // note press holds the play back from the leaderboard; a pad-only run submits.
  const noteInputRef = useRef({ keyboard: false, pad: false });
  // The input log of the play just finished — replayed in place by WATCH REPLAY
  // without a storage round-trip.
  const lastReplayRef = useRef<ReplayEvent[]>([]);

  // Room race: re-render on room updates (rivals readying/snapping/finishing)
  // via the store subscription; the room itself outlives this screen.
  useSyncExternalStore(subscribeRoom, roomState);
  const [vsWaiting, setVsWaiting] = useState(false);
  const versusRef = useRef(req.versus);
  versusRef.current = req.versus;
  // Report our race result exactly once (natural finish, fail, or quit-DNF).
  const finishSentRef = useRef(false);
  const sendFinish = (r: PlayResult) => {
    const room = versusRef.current?.room;
    if (!room || finishSentRef.current) return;
    finishSentRef.current = true;
    room.finish(r);
  };
  // Wall-clock gameplay time for the lifetime stats.
  const playStartedAtRef = useRef(0);
  useEffect(() => {
    if (phase === 'playing') playStartedAtRef.current = performance.now();
  }, [phase]);
  // Standings reveal (results screen): first confirm skips, later ones continue.
  const [skipSignal, setSkipSignal] = useState(0);
  const standingsRevealedRef = useRef(false);

  // Stream to the rivals while playing: freshly-judged notes (their copy of
  // our playfield) every tick, the scoreboard snap every other tick. Derived
  // stats and display events only — judging never crosses the wire.
  useEffect(() => {
    const m = req.versus?.room;
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
      // Paint each rival mirror from ITS player's judged-note feed (display only
      // — mirror the judge's own rule: consumed by input unless it was a Miss).
      const nowS = s.songNow;
      for (const rv of rivalsRef.current) {
        const rival = m.players.find((p) => p.id === rv.id);
        if (!rival) continue;
        const feed = rival.notes;
        while (rv.cursor < feed.length) {
          const { i, tns } = feed[rv.cursor++];
          const n = rv.judge.notes[i];
          if (!n) continue; // hostile/mismatched index — display feed, skip
          n.tns = tns;
          n.hidden = tns !== TapNoteScore.Miss;
          if (n.isHold && n.hidden) n.holdInitiated = true; // assume they hold it
          if (tns !== TapNoteScore.AvoidMine && tns !== TapNoteScore.Miss) {
            rv.feedback.laneFlash[n.track] = nowS;
            rv.feedback.laneHit[n.track] = { tns, atSeconds: nowS, white: false };
          }
          if (tns !== TapNoteScore.AvoidMine) {
            rv.feedback.lastJudgment = { tns, atSeconds: nowS, white: false };
          }
        }
        const snap = rival.snap;
        if (snap) {
          rv.judge.combo = snap.combo;
          rv.judge.life = snap.life;
          // The mirror judge is never re-scored (it only gets tns for rendering),
          // so drive its displayed score/grade straight from the streamed percent.
          rv.judge.displayPercent = snap.percent;
        }
      }
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

  // The rivals' mirror judges/feedback (painted from the streamed feed above,
  // drawn by the session as extra field views on the same canvas). Up to 3
  // rivals are shown as fields. Each keeps its own scan cursor into its
  // player's note feed.
  const rivalsRef = useRef<{ id: number; judge: Judge; feedback: Feedback; cursor: number }[]>([]);

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
      if (e.pressed) {
        // Remember which device drove a NOTE column this run (submission gate).
        if (e.device === 'keyboard') noteInputRef.current.keyboard = true;
        else if (e.device === 'gamepad') noteInputRef.current.pad = true;
        sessionRef.current?.press(col, e.timeStampMs);
      } else sessionRef.current?.release(col, e.timeStampMs);
      return;
    }
    if (!e.pressed || e.repeat) return;
    // Results screen: ▲▼ walks CONTINUE / RETRY / WATCH REPLAY (versus is
    // CONTINUE-only; WATCH REPLAY only after a real, non-replay solo play).
    if (phaseRef.current === 'done' && (e.role === 'up' || e.role === 'down')) {
      e.nativeEvent?.preventDefault();
      if (versusRef.current) {
        setDoneSel(0);
        return;
      }
      const maxSel = result && !result.isReplay ? 2 : 1;
      setDoneSel((prev) => {
        const next = e.role === 'up' ? prev - 1 : prev + 1;
        return Math.max(0, Math.min(maxSel, next));
      });
      return;
    }
    if (e.role === 'confirm') {
      // While the standings are still revealing, the first confirm SKIPS the
      // show (before the focused CONTINUE can swallow the press). The ref
      // flips HERE, synchronously — the React round-trip through the
      // standings component is async, and a quick second press must read
      // "already skipped" and mean CONTINUE, never a second eaten skip.
      if (phaseRef.current === 'done' && versusRef.current && !standingsRevealedRef.current) {
        standingsRevealedRef.current = true;
        e.nativeEvent?.preventDefault();
        setSkipSignal((s) => s + 1);
        return;
      }
      // A focused button already activates on the native Enter keydown — skip
      // ONLY for real Enter presses, or a confirm bound to any other key
      // (Slash, a pad-adapter key) is silently dead on the results screen.
      if (
        e.device === 'keyboard' &&
        document.activeElement?.tagName === 'BUTTON' &&
        (e.nativeEvent?.code === 'Enter' || e.nativeEvent?.code === 'NumpadEnter')
      )
        return;
      e.nativeEvent?.preventDefault();
      const sel = doneSelRef.current;
      (sel === 2 ? watchReplayRef : sel === 1 ? retryRef : ctaRef).current?.click();
    } else if (e.role === 'back') {
      e.nativeEvent?.preventDefault();
      onExitRef.current();
    }
  });

  useEffect(
    () => () => {
      bankSteps(sessionRef.current);
      // Quitting a race mid-song is a DNF — tell the room before the session
      // dies (the room itself lives on; only this play's ride-along ends).
      const s = sessionRef.current;
      const room = versusRef.current?.room;
      if (s && room && phaseRef.current === 'playing') {
        sendFinish({
          percent: Math.max(0, Math.min(1, s.judge.percentDancePoints)),
          grade: s.judge.grade,
          maxCombo: s.judge.maxCombo,
          failed: true,
          counts: { ...s.judge.tapCounts },
          holdCounts: { ...s.judge.holdCounts },
        });
      }
      if (room) room.onGo = undefined;
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
  // Entering results resets the selection to CONTINUE and re-arms the
  // standings reveal (a race's first confirm skips the show, not the screen).
  useEffect(() => {
    if (phase !== 'playing') ctaRef.current?.focus();
    if (phase === 'done') {
      setDoneSel(0);
      standingsRevealedRef.current = !versusRef.current;
    }
  }, [phase]);

  // On the results screen, keep DOM focus on the ▲▼-selected button so a
  // keyboard Enter and a pad confirm both activate the same one.
  useEffect(() => {
    if (phase === 'done')
      (doneSel === 2 ? watchReplayRef : doneSel === 1 ? retryRef : ctaRef).current?.focus();
  }, [phase, doneSel]);

  const start = async (replayEvents?: ReplayEvent[]) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const replaying = replayEvents != null;
    bankSteps(sessionRef.current);
    sessionRef.current?.stop();
    cleanupBg();
    // Fresh per-run note-device tracking (drives the submission gate).
    noteInputRef.current = { keyboard: false, pad: false };
    // The best to beat THIS run (a retry after a record compares to the record).
    const pbRec = loadScores()[chartKey(req.song, req.chart)];
    setPbPercent(pbRec ? pbRec.percent : null);
    // A replay run is inert: it counts no song play (and banks no steps below).
    if (!replaying && !playCountedRef.current) {
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
      hudDensity: settings.hudDensity,
      practice: req.practice ?? null,
    });
    session.resize(canvas.clientWidth, canvas.clientHeight);
    if (replaying) {
      session.setReplay(replayEvents);
      // A replay's re-simulated steps must never bank into lifetime stats —
      // pre-mark it banked so every bankSteps() path (unmount, next start) skips it.
      bankedRef.current.add(session);
    }
    // Live versus: a mirror judge over EACH rival's chart renders as an extra
    // view on the session's own canvas. The 100 ms streamer below paints each
    // from its player's judged-note feed; the session just draws what's there.
    // Cap the RENDERED fields at 3 rivals (4 players) so the layout stays
    // readable and fast. Rivals past the cap, or whose exact chart revision
    // isn't local, aren't drawn as fields; the end-of-song standings still
    // account for every player.
    rivalsRef.current = [];
    const MAX_RIVAL_FIELDS = 3;
    const renderable = (req.versus?.opponents ?? []).filter((o) => o.chart);
    if (renderable.length > MAX_RIVAL_FIELDS) {
      console.log(
        `[versus] ${renderable.length} rivals have local charts; rendering the first ${MAX_RIVAL_FIELDS} as fields, the rest only in the end-of-song standings`,
      );
    }
    const rivalCfgs: Parameters<GameSession['setRivalFields']>[0] = [];
    const rivalSrcs: GameSession['rivalSources'] = [];
    for (const opp of renderable.slice(0, MAX_RIVAL_FIELDS)) {
      const rc = opp.chart!;
      const rnd = rc.getNoteData();
      const rTiming = rc.getTimingData(req.song.timing);
      const rivalJudge = new Judge(rnd, rTiming, DEFAULT_WINDOWS, effRate, null);
      const rivalFeedback: Feedback = {
        lastJudgment: null,
        laneFlash: new Array<number>(rnd.numTracks).fill(-999),
        laneHit: new Array<Feedback['laneHit'][number]>(rnd.numTracks).fill(null),
      };
      rivalCfgs.push({
        numTracks: rnd.numTracks,
        columnAngles: columnAnglesFor(rc.stepsType, rnd.numTracks),
        meta: {
          title: opp.name,
          subtitle: 'LIVE RIVAL',
          difficulty: `${rc.stepsType}  ·  ${difficultyToString(rc.difficulty).toUpperCase()} ${rc.meter}`,
        },
      });
      rivalSrcs.push({ judge: rivalJudge, feedback: rivalFeedback });
      rivalsRef.current.push({
        id: opp.id,
        judge: rivalJudge,
        feedback: rivalFeedback,
        cursor: 0,
      });
    }
    session.setRivalFields(rivalCfgs);
    session.rivalSources = rivalSrcs;
    setLoopNum(1);
    session.onLoop = setLoopNum;
    setLoadStage({ stage: 'PREPARING', frac: 0.05 });
    session.onLoadStage = (stage, frac) => {
      if (sessionRef.current === session || sessionRef.current === null) {
        setLoadStage({ stage, frac });
      }
    };
    session.onError = () => {
      if (sessionRef.current === session) setPhase('error');
    };
    session.onEnd = (judge) => {
      const counts = { ...judge.tapCounts };
      // Replay playback is inert: no scoring, no submission, no lifetime stats,
      // no room finish — just show the re-simulated results with a REPLAY mark.
      if (session.isReplay) {
        setResult({
          percent: judge.percentDancePoints,
          grade: judge.grade,
          maxCombo: judge.maxCombo,
          failed: judge.failed,
          counts,
          holdCounts: { ...judge.holdCounts },
          best: null,
          isNewRecord: false,
          offsets: [...session.offsets],
          keyboardBlocked: false,
          isReplay: true,
        });
        setPhase('done');
        return;
      }
      bankSteps(session);
      playCountedRef.current = false; // a RETRY from here is a new play
      // Keep this run's log so WATCH REPLAY re-runs it without a storage trip.
      lastReplayRef.current = [...session.inputLog];
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
            failed: judge.failed,
          });
      // Submission gate (anti-cheat): a keyboard note press this run holds the
      // play off the leaderboard entirely — local records still stand. A
      // pad-only run submits with its device tag + full replay.
      const usedKeyboard = noteInputRef.current.keyboard;
      const padId = connectedPadInfo()[0]?.id || 'Gamepad';
      const input: SubmitInput = { device: 'pad', padId, padKnown: looksLikeDancePad(padId) };
      // Online leaderboard (fire-and-forget; queued offline). Practice
      // sections never submit; keyboard plays never submit; rate-modded plays
      // do — the server partitions boards by rate (never the 1.0x one).
      if (req.practice == null && !usedKeyboard) {
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
          input,
          chartData: chartDataOf(req.song, req.chart),
          replay: [...session.inputLog],
          ...(session.ghostFrames.length > 0 ? { ghost: [...session.ghostFrames] } : {}),
        });
      }
      // Lifetime stats: fold the finished play in (steps bank separately).
      recordPlayEnd({
        seconds: Math.max(0, (performance.now() - playStartedAtRef.current) / 1000),
        failed: judge.failed,
        counts,
        holdCounts: { ...judge.holdCounts },
        maxCombo: judge.maxCombo,
      });
      // Tell the room how it went; standings fill in as results arrive.
      sendFinish({
        percent: Math.max(0, Math.min(1, judge.percentDancePoints)),
        grade: judge.grade,
        maxCombo: judge.maxCombo,
        failed: judge.failed,
        counts,
        holdCounts: { ...judge.holdCounts },
      });
      // Bank this play's tap errors for the settings TIMING recommendation.
      // Rate-modded plays are skipped: songSecondsAtPerf scales wall-clock by
      // the rate BEFORE adding the offset, so a 20 ms hardware latency logs as
      // 30 ms at 1.5× and would bias the suggestion.
      if (effRate === 1) recordPlayOffsets(session.offsets, settings.audioOffsetMs);
      setResult({
        percent: judge.percentDancePoints,
        grade: judge.grade,
        maxCombo: judge.maxCombo,
        failed: judge.failed,
        counts,
        holdCounts: { ...judge.holdCounts },
        best,
        isNewRecord,
        offsets: [...session.offsets],
        keyboardBlocked: req.practice == null && usedKeyboard,
        isReplay: false,
      });
      setPhase('done');
    };
    sessionRef.current = session;

    // Background (unless the player turned it off).
    if (settings.bgMode !== 'off') {
      // The procedural GPU dance background — beat-locked, dancer stepping to
      // this chart's StepParity foot placement. Used when a song has no BGA of
      // its own, or forced for every song when bgMode is 'dance'.
      const useDanceBg = (): void =>
        session.setAttract({
          ...buildAttractConfig(req.song.title, req.song.timing, req.chart),
          // The heavy textured VRM avatar loads ONLY when the player picked the
          // 'dance' background — that's its purpose, and it carries a real cost
          // (a whole three.js WebGPU renderer + spring physics + foot-IK per
          // frame). For a BGA-less song in 'dim'/'full' we still want the neon
          // tunnel, but NOT the avatar (it'd render offscreen unseen, wasting the
          // GPU and — in software-WebGPU CI — stalling the field). Versus also
          // skips it: two avatars on one perf box starve the note field.
          model: !req.versus && settings.bgMode === 'dance',
        });
      if (settings.bgMode === 'dance') {
        useDanceBg();
      } else if (req.backgroundFile && isVideoFile(req.backgroundFile.name)) {
        const url = URL.createObjectURL(req.backgroundFile);
        bgUrlRef.current = url;
        const v = document.createElement('video');
        v.src = url;
        v.muted = true;
        v.playsInline = true;
        v.preload = 'auto';
        bgMediaRef.current = v;
        // A movie's frame 0 plays at its #BGCHANGES trigger beat, not song start.
        session.setBackground(v, req.song.timing.getElapsedTimeFromBeat(req.song.bgVideoStartBeat));
      } else if (req.backgroundFile) {
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
      } else {
        // No background of its own — fall back to the dance background.
        useDanceBg();
      }
    }

    if (import.meta.env.DEV) {
      (window as unknown as { __nfSession?: GameSession }).__nfSession = session;
      // The live room peer, so tests can observe rival progress/DNF from room
      // state (what the end-of-song standings render) now that the in-play
      // rival overlay is gone. Null in solo/practice.
      (window as unknown as { __nfRoom?: unknown }).__nfRoom = req.versus?.room ?? null;
    }
    setResult(null);
    // Keep the LOADING splash up through GPU init + audio decode + prewarm, and
    // reveal the field only once start() has the live loop running. (Flipping to
    // 'playing' up front dropped the splash during the multi-second decode, when
    // the field was still blank / mid-prewarm.) The no-WebGPU and device-lost
    // paths flip us to 'error' via onError — don't stomp that.
    setPhase('ready');
    if (req.versus) {
      // Room race: prepare (GPU + decode), report loaded, and hold until the
      // host's latency-compensated 'go' — every machine begins on one instant.
      const m = req.versus.room;
      finishSentRef.current = false;
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

  return (
    <div
      ref={wrapRef}
      className="fixed inset-0 overflow-hidden bg-[#050506] font-grotesk [font-variant-numeric:tabular-nums]"
    >
      {/* One canvas, one render: in versus the field draws BOTH players'
          views side by side over a single shared background. */}
      <canvas ref={canvasRef} className="relative z-[1] block h-full w-full" />

      {/* Solo ARCADE: the DOM HUD owns the chrome around the untouched field —
          score, timing, chart timeline, bottom strip (song info, progress,
          fullscreen, the signposted SELECT · HOLD TO QUIT, FPS). The old
          bottom-left ⛶ / ← SONGS cluster is gone: it was drawn on top of the
          score panel and was a mouse-only instant exit pad players couldn't
          see. The ITG skin keeps Simply Love's own GPU side panel (its
          hudUnderlay draws life/percent/density) — the DOM HUD would draw on
          top of it, so it stays off for that skin. */}
      {phase === 'playing' && !req.versus && settings.noteSkin === 'arcade' && (
        <PlayHud
          song={req.song}
          chart={req.chart}
          telemetry={telemetry}
          density={settings.hudDensity}
          skin={settings.noteSkin}
          reverse={settings.reverse}
          numTracks={numTracks}
          musicRate={effRate}
          // Rate-modded runs aren't comparable to the stored 1.0× best — no delta.
          pbPercent={effRate === 1 ? pbPercent : null}
          practiceNote={
            sessionRef.current?.isReplay
              ? '▶ REPLAY'
              : req.practice
                ? `PRACTICE · M${Math.floor(req.practice.startBeat / 4) + 1}–M${Math.max(1, Math.floor(req.practice.endBeat / 4))} · LOOP ${loopNum}`
                : null
          }
          fps={hudFps}
          onFullscreen={toggleFullscreen}
        />
      )}

      {/* Versus (no HUD column — 2P's field lives there) and the ITG skin
          (Simply Love draws its own panel) keep minimal chrome: fullscreen,
          FPS, and the hold-to-quit signpost the DOM strip normally carries. */}
      {phase === 'playing' && (req.versus || settings.noteSkin !== 'arcade') && (
        <>
          <div className="absolute bottom-4 left-4 z-[3] flex items-center gap-3">
            <button onClick={toggleFullscreen} title="Fullscreen" className={CTL_BTN}>
              ⛶
            </button>
            <span className="flex items-center gap-2 font-display text-[12px] tracking-[0.14em] text-[#ececec]/45">
              <span className="inline-flex h-[20px] min-w-[26px] items-center justify-center border border-white/[0.14] px-1.5 text-[11px] text-[#ececec]">
                SELECT
              </span>
              HOLD TO QUIT
            </span>
          </div>
          <FpsMeter />
        </>
      )}

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

      {/* The pre-song wait (design 6c): brief the player — chart shape, target,
          mods — instead of blinking LOADING at them. */}
      {phase === 'ready' && (
        <LoadingSplash
          song={req.song}
          chart={req.chart}
          pack={req.entry?.pack}
          settings={settings}
          effRate={effRate}
          stage={loadStage.stage}
          frac={loadStage.frac}
          statusOverride={req.versus && vsWaiting ? 'SYNCING WITH THE ROOM…' : null}
        />
      )}

      {phase === 'error' && (
        <div
          className="absolute inset-0 z-[2] flex flex-col items-center justify-center gap-3 p-6 text-center text-[#ececec] backdrop-blur-[2px]"
          style={{ background: 'rgba(5,6,8,.82)' }}
        >
          <div className="text-[19px] font-bold tracking-[0.22em]">RENDERING FAILED</div>
          <div className="mt-2 max-w-[440px] text-[15px] leading-relaxed text-[#ececec]/70">
            The note field needs WebGPU and couldn&apos;t start (or the GPU device was lost
            mid-song). Try a recent Chrome or Edge with hardware acceleration enabled, then come
            back in.
          </div>
          <button
            onClick={onExit}
            className="mt-4 border px-4 py-1.5 text-[14px] tracking-[0.18em]"
            style={{ borderColor: AC, background: AC + '1a' }}
          >
            ← SONGS
          </button>
        </div>
      )}

      {/* Results (design 5a "SCORECARD"): verdict · breakdown · progress. */}
      {phase === 'done' && result && (
        <Results
          song={req.song}
          chart={req.chart}
          result={result}
          pbPercent={pbPercent}
          effRate={effRate}
          isVersus={!!req.versus}
          isPractice={req.practice != null}
          doneSel={doneSel}
          ctaRef={ctaRef}
          retryRef={retryRef}
          watchReplayRef={watchReplayRef}
          onContinue={onExit}
          onRetry={() => void start()}
          onWatchReplay={(events) => void start(events)}
          lastReplay={lastReplayRef.current}
        >
          {req.versus && (
            <RoomStandings
              versus={req.versus}
              skipSignal={skipSignal}
              onRevealed={(done) => (standingsRevealedRef.current = done)}
            />
          )}
        </Results>
      )}
    </div>
  );
}
