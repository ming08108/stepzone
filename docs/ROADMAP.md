# Roadmap

Milestones are vertical where possible: each ends with something verifiable
(tests, or a playable slice). The engine layers are built and tested pure before
the browser-coupled layers.

## M1 — Parse & Time ✅ (done)

The pure data foundation.

- MSD tokenizer; `.ssc` + basic `.sm` parsing into Song/Steps.
- Note grid decode into `NoteData` (holds, mines, keysounds, the `,,` quirk).
- `TimingData` beat⇄second conversion: BPMs, stops, delays, warps.
- Pure `SyncMap` clock math.
- 29 unit tests, including the spec doc-9 worked example reproduced exactly.

## M2 — Gameplay logic (pure, testable)

Judgment/scoring/life as pure functions over `NoteData` + a timeline of input
events. No audio or DOM yet, so it's unit-testable.

- Timing windows (W1–W5, mine, hold, roll) and `GetWindowSeconds`.
- `Step()`: closest-note search, offset → score, warp/fake exclusion.
- Miss aging, combo rules (W3 keeps / breaks), hold/roll life.
- Dance-point %, grade, life meter deltas (verified metric defaults).
- **Test:** the spec doc-9 input trace (W1 / W3 / Miss / Held / HitMine →
  53.3%) becomes an assertion.

## M3 — First playable slice

Wire the browser layers around the M1/M2 core.

- `WebAudioClock` playing a decoded `AudioBuffer`, anchored via
  `getOutputTimestamp` (see [LATENCY.md](LATENCY.md)).
- Keyboard input → column via a Style table; timestamped judging.
- Canvas note field: CMod first (immune to BPM/scroll gimmicks), then XMod +
  scroll/speed segments.
- Play the bundled example end to end.

## M4 — Real songs

- Load a song folder (simfile + audio + banner) via file input / drag-drop or a
  bundled pack.
- Song-select UI; difficulty picker.
- Preview clips (sample start/length).

## M5 — Feature parity for play

- Scroll-speed mods (X/C/M), reverse, mirror/turns.
- Noteskins (quantization coloring is already wired).
- Results screen (grade, judgment counts, life graph).
- Offset calibration screen (audio + visual), the honest latency fix.

## M6 — Edge-case completeness

- `.sm` negative-BPM / negative-stop → warp conversion (spec doc 2 §2.5).
- Composite / routine (`&`-separated) charts.
- Round-trip serialization + `ChartKey` hashing for validation (spec doc 10
  §10.7).
