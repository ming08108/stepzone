# Getting low latency right on the web

Timing is the entire product. A rhythm game judges to ±22 ms (a "Marvelous"),
so any systematic error in the clock, the input path, or their alignment is
felt immediately. The web platform makes this harder than native because the
audio clock and the input clock live on **different timebases** and the true
output latency is only partially observable. This doc is the plan for doing it
correctly, and how the code embodies it.

## The core principle

> One audio-derived clock is the source of truth. Every beat, note position, and
> judgment derives from it. Input is timestamped at the event, not the frame.
> Judging and rendering are two reads of the same clock at different times.

Everything below serves that principle.

## 1. The clock is the audio hardware, never `requestAnimationFrame`

`requestAnimationFrame` fires at display cadence (typically 60/120 Hz) and drifts
from audio. `Date.now()` / `performance.now()` are wall clocks that also drift
from the sound card. The only clock that stays locked to what the player hears
is the audio hardware, exposed via `AudioContext`.

- The song is decoded **fully** into an `AudioBuffer` (`decodeAudioData`) and
  scheduled with `AudioBufferSourceNode.start(when)`. Because we choose `when`,
  song-second 0 maps to a known context time exactly — no streaming jitter, no
  `<audio>.currentTime` (which is coarse, tens of ms).
- We create the context with `{ latencyHint: 'interactive' }` to ask the
  platform for the smallest output buffer it will give us.

Code: [`src/audio/clock.ts`](../src/audio/clock.ts) (`WebAudioClock.start`).

## 2. The two-timebase problem, and the bridge

Here is the subtlety most web rhythm games get wrong:

- `AudioContext.currentTime` is in **seconds** on the audio timebase.
- `KeyboardEvent.timeStamp` is in **milliseconds** on the `performance.now()`
  timebase.

They are **not** the same clock, and `currentTime` is a _write_ cursor — the
sound it points at won't be **heard** until `outputLatency` later. So you cannot
just compare an input's `timeStamp` to `currentTime`.

The bridge is [`AudioContext.getOutputTimestamp()`], which returns a pair:

```
{ contextTime, performanceTime }  // "the sample at contextTime is HEARD at performanceTime"
```

That pair already folds in output latency. We treat it as an **anchor** and
interpolate from it. Given an anchor `(c0, p0)`, the audible context time at any
performance timestamp `p` is `c0 + (p − p0)/1000`, and the audible song position
is `(that − startContextTime) × playbackRate + calibration`.

This is the whole of [`src/audio/syncMap.ts`](../src/audio/syncMap.ts) — kept
**pure** (no Web Audio) so the math is unit-tested
([`tests/syncMap.test.ts`](../tests/syncMap.test.ts)). `WebAudioClock` just feeds
it fresh anchors each frame.

Because both "now" (for rendering) and "the input event" (for judging) are mapped
through the **same** anchor, input and audio are automatically on the same
**audible** axis. That is what makes hits land where the arrows visibly are.

### Fallback when `getOutputTimestamp` is unavailable

Not every browser fills it in immediately. `WebAudioClock.refresh()` falls back
to anchoring on `currentTime − (outputLatency || baseLatency)` paired with
`performance.now()`. Slightly less precise, same shape.

## 3. Input: timestamp at the event, ignore auto-repeat

- Judge against `KeyboardEvent.timeStamp`, **not** the time your handler runs
  inside a frame — a frame can be 16 ms late, which is most of a W2 window.
- Ignore `event.repeat` (the OS key-repeat storm); it's the browser's
  `IET_REPEAT`.
- Use `KeyboardEvent.code` (physical key, layout-independent), routed through a
  Style table to a column (spec doc 7). A key is not a column.
- Maintain the set of currently-down columns yourself for hold/roll life
  (the analogue of the engine polling `IsBeingPressed`).

For dance pads that present as gamepads, the Gamepad API is **poll-only** — you
read state and synthesize press/release edges (`src/input/gamepad.ts`,
`inputBus.ts`), so pad input is coarser than keyboard. Two mechanisms carry the
weight, and they compose:

- **Timestamp from the device sample, not the poll.** A detected transition is
  stamped with `Gamepad.timestamp` (when the browser sampled the pad, same clock
  as `performance.now()`) rather than the frame we noticed it — removing most of
  the quantization jitter. This is what keeps **judging** accurate even when we
  only poll once per frame: judging rides the sample time, not the render frame.
  Falls back to poll time when the platform omits the timestamp (older Firefox).
- **Poll on `requestAnimationFrame`** as the fallback. A vsync-aligned cadence is
  steadier and cheaper than a busy timer loop, and — because the timestamp above
  gives the real event time — the poll rate only bounds visual-feedback latency,
  not judging. The loop **stops entirely** once the event-driven API proves live;
  connect/disconnect are handled by their own events, so nothing is polled.
- **Event-driven when the flag is on.** `chrome://flags/#gamepad-raw-input-change-event`
  (also `edge://`) exposes `gamepadrawinputchanged` on `window`; we attach the
  listener unconditionally (harmless when it never fires) so it lights up when the
  user enables it — a one-time hint suggests it when a pad is connected.

**Does the event API still help if we have `Gamepad.timestamp`?** Yes, at low
refresh rates and for fast input. A frame poll only samples state at frame
boundaries, so (a) a tap that goes down-and-up **between** two frames is missed
entirely, and (b) if the device (or a noisy analog stick) advanced the timestamp
after the actual press, the stamped time is the latest sample at the poll, late
by up to a frame (~16 ms at 60 Hz — inside a W1 window). The event fires on the
exact report that changed, so it never misses a transition and pins the timestamp
to the true press time. `Gamepad.timestamp` makes the poll fallback _good_; the
event API makes it _exact and complete_.

The ceiling is the pad's USB HID report rate (125–1000 Hz), and — with polling —
what `getGamepads()` exposes to JS (often ~250 Hz internally). **OPTIONS →
DISPLAY → Test input quantization** infers it live from the `Gamepad.timestamp`
granularity, and shows whether the event API is actually firing. Keyboard-emulating
pad adapters remain the lowest-jitter option (real `keydown` timestamps).

## 4. Calibration is not optional

No web API tells you the _true_ end-to-end latency (audio output + display +
input + the player's own reaction bias). So, exactly like StepMania's
`AdjustSync`, we expose two user offsets:

- **Audio offset** (`SyncMap.audioOffsetSeconds`) — shifts the judged song time.
- **Visual offset** — shifts only the _render_ beat, never judgment (see §5).

A calibration screen (planned) collects taps to a metronome and sets the audio
offset to the mean error when it's consistent — the same technique as the
engine's offset auto-sync (spec doc 6 §6.4). This is the honest fix for latency
the platform won't disclose, especially Bluetooth audio (which can add
100–300 ms and varies by device).

## 5. Judgment time vs render time are different reads

- **Judgment** uses the raw audible song time (`songSecondsAtEvent`).
- **Rendering** uses the audible song time **minus a visual delay**, so a player
  can nudge arrows visually without touching hit timing.

Keeping these separate (as StepMania does with `m_fSongBeat` vs
`m_fSongBeatVisible`) is why a visual-offset slider doesn't secretly change
scoring. The render loop reads `songSecondsNow()`; judgment reads
`songSecondsAtEvent(e.timeStamp)`.

## 6. What we deliberately avoid

- No judging "on the frame" or from rAF deltas.
- No `<audio>` element as the clock.
- No assuming `currentTime` is the audible position (it's the write cursor).
- No comparing `event.timeStamp` to `currentTime` directly (different timebases).
- No per-frame BPM integration for position — we go through the tested
  beat⇄second conversion (spec doc 2) every time.

## 7. Residual risks we're tracking

- **AudioWorklet**: for per-note keysounds (BMS-style charts) we may schedule
  many short buffers; if main-thread jank becomes an issue we move scheduling to
  an `AudioWorklet`. The music track itself needs no worklet.
- **Context resume**: the `AudioContext` must be resumed from a user gesture;
  the start flow enforces this.
- **Clock discontinuities**: on tab-visibility changes the anchor can jump; we
  re-anchor every frame, so a stale anchor self-corrects within one frame.
- **Sub-quantum smoothness**: `currentTime` advances in ~2.7–5.8 ms steps;
  interpolating from the anchor via `performance.now()` gives a continuous clock
  between steps.

## Where this lives in the code

| Concern                                    | File                                                            |
| ------------------------------------------ | --------------------------------------------------------------- |
| Pure clock math (tested)                   | `src/audio/syncMap.ts`                                          |
| Web Audio glue, anchor refresh, scheduling | `src/audio/clock.ts`                                            |
| Beat ⇄ second conversion                   | `src/timing/timingData.ts`                                      |
| Spec background                            | `../itgmania/Docs/TrackPlayerSpec/06-runtime-clock-and-sync.md` |
