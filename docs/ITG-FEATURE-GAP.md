# ITGmania Feature Gap

What full ITGmania (a StepMania 5.1 fork) supports that **Stepzone** does not yet
have. Purpose: plan future work. Derived from the ITGmania C++ source
(`../itgmania/src`) and the reimplementation spec (`../itgmania/Docs/TrackPlayerSpec`)
compared against Stepzone's `src/`, `docs/ROADMAP.md`, `docs/ENGINE-REVIEW.md`, and
`todo.txt`.

## Summary

Stepzone faithfully implements the **core data + play path** for one **4‑panel
dance‑single** chart: `.sm`/`.ssc` parsing, timing (BPM/stop/delay/warp incl. `.sm`
negative‑BPM→warp and `.ssc` split timing), tap/hold/roll/mine judgment, DDR
dance‑point scoring + grade tiers + a bar life meter, C/X/M scroll, a few turn mods,
keyboard/gamepad input, a searchable song library with per‑chart best scores, and
image/video backgrounds. This is a strong, well‑tested single‑player engine.

The gap is essentially **the entire product surface around that core**. ITGmania is a
full arcade rhythm‑game platform: a large gameplay‑modifier/visual‑effect catalog,
alternate game types (pump/techno) and multiplayer (versus/routine/battle/rave),
courses (nonstop/oni/survival/endless/workout), player+machine profiles with records
and rankings, a full chart editor, swappable noteskins and a Lua‑scripted theme layer,
and built‑in networking/GrooveStats. Roughly: the **single‑player dance engine is
~80–90% complete**, but **feature breadth vs. all of ITGmania is ~15–20%**.

**~120 distinct gaps** below across **12 categories**. Legend — **E** = implementation
effort, **P** = priority for a DDR/ITG‑faithful web player. Both low / med / high.
"Partial" marks things Stepzone already covers in part. Note: ITGmania ships **only**
the _dance, pump, techno, lights_ games (beat/kb7/para/pop'n/ez2/maniax were removed),
so those legacy games are **not** counted as gaps.

---

## 1. Gameplay modifiers (`PlayerOptions`)

Stepzone has: C/X/M scroll, `mirror/left/right/shuffle` turns, music‑rate, audio/visual
offset. The rest of ITGmania's very large `PlayerOptions` surface is absent.

| Gap                                                                                                                                                                                                                     | E       | P        | Notes                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- | ------------------------------------------------------------- |
| **Reverse** scroll (+ per‑column reverse)                                                                                                                                                                               | low     | **high** | Single most‑used mod; arrows scroll downward.                 |
| Scroll: Split / Alternate / Cross / Centered                                                                                                                                                                            | low‑med | med      | Other receptor/scroll arrangements.                           |
| **Appearance: Hidden / Sudden** (+ offsets)                                                                                                                                                                             | med     | **high** | Arrows vanish/appear partway; staple practice/score mods.     |
| Appearance: Stealth / Blink / RandomVanish                                                                                                                                                                              | med     | med      | Full/partial invisibility variants.                           |
| Turn: LRMirror / UDMirror / Backwards                                                                                                                                                                                   | low     | med      | Missing turn variants.                                        |
| Turn: Soft / Super / Hyper Shuffle                                                                                                                                                                                      | low     | med      | Fairer/looser column randomizers (only plain shuffle exists). |
| **Transforms – removers:** NoHolds, NoRolls, NoMines, NoJumps, NoHands, NoLifts, NoFakes, NoQuads, NoStretch                                                                                                            | low‑med | med      | Pure `NoteData` transforms; common practice aids.             |
| **Transforms – adders:** Little, Wide, Big, Quick, Skippy, Mines, AttackMines, Echo, Stomp, Planted, Floored, Twister, BMRize, HoldRolls                                                                                | med     | low‑med  | Insert/alter notes (harder charts, joke mods).                |
| Acceleration: Boost / Brake / Wave / Expand / TanExpand / Boomerang                                                                                                                                                     | med     | med      | Arrow speed varies along the field.                           |
| Effect (position/rotation) mods: Drunk, Dizzy, Confusion, Tornado, Tipsy, Bumpy, Beat, Digital, Zigzag, Sawtooth, Square, Parabola, Bounce, Pulse, Attenuate, Shrink, Flip, Invert, Roll, Twirl, Xmode (~130 sub‑knobs) | high    | low‑med  | Needs a GPU/transform renderer; mostly cosmetic.              |
| Perspective: Overhead / Distant / Incoming (tilt) + Skew                                                                                                                                                                | high    | med      | 3D note field; requires perspective renderer.                 |
| Note size / field: Tiny, Mini, DrawSize, DrawSizeBack (draw distance)                                                                                                                                                   | med     | low      |                                                               |
| Hide/obscure: Dark (hide receptors), Blind (hide judgment), Cover, StealthPastReceptors, MinTNSToHideNotes                                                                                                              | low     | low      |                                                               |
| Passmark (must hold life ≥ X% to pass)                                                                                                                                                                                  | low     | low      | Independent of fail type.                                     |
| RandomSpeed, RandomAttack / NoAttack                                                                                                                                                                                    | low‑med | low      | Randomized speed / random in‑song attacks.                    |
| ModTimer (Beat/Song/Game) + `Approach` (mods ramp in over time, `*n` speed)                                                                                                                                             | med     | low      | In‑song animated/ramped modifier changes.                     |
| Cosecant, DizzyHolds, ZBuffer, MuteOnError, HideLights, `m_bSetScrollSpeed`                                                                                                                                             | low     | low      | Assorted toggles.                                             |

## 2. Life meter & fail

Stepzone has: **Bar** life only, raw per‑judgment deltas, single fail latch at life 0
(shown as FAILED on results). No mid‑song game‑over screen.

| Gap                                                                                                            | E   | P       | Notes                                                   |
| -------------------------------------------------------------------------------------------------------------- | --- | ------- | ------------------------------------------------------- |
| **Battery** life (fixed lives)                                                                                 | med | med     | Needed for Oni courses.                                 |
| **Time / Survival** life (draining clock)                                                                      | med | med     | Needed for Survival courses.                            |
| Drain types: NoRecover, SuddenDeath                                                                            | low | med     | Harder life rules.                                      |
| FailType variants: Immediate / ImmediateContinue / EndOfSong / Off                                             | low | med     | Stepzone only has immediate‑at‑0. Partial.             |
| Life‑bar refinements: merciful drain, progressive bar, combo‑to‑regain, drain scaling, "hot"/full‑combo states | med | low‑med | Partial: raw deltas only (documented in ENGINE‑REVIEW). |

## 3. Note & timing features

Stepzone **parses all segment types** (BPM/Stop/Delay/Warp/Scroll/Speed/TimeSig/
Tickcount/Combo/Label/Fake) and applies BPM/Stop/Delay/Warp; judges tap/hold/roll/mine;
excludes fakes; judges lifts. Handles `.ssc` split (per‑chart) timing. Gaps are mostly
_runtime application_ of already‑parsed data.

| Gap                                                                        | E   | P   | Notes                                                       |
| -------------------------------------------------------------------------- | --- | --- | ----------------------------------------------------------- |
| **Scroll segments** (`#SCROLLS`) rendered                                  | med | med | Parsed, not applied — visual scroll‑rate gimmicks. Partial. |
| **Speed segments** (`#SPEEDS`, ramped x‑mod) rendered                      | med | med | Parsed, not applied. Partial.                               |
| **Checkpoint holds / Tickcount** (holds re‑judged every N ticks, pump/ITG) | med | med | `CheckpointHit/Miss` enums exist but unused. Partial.       |
| Combo segments (`#COMBOS` — rows worth >1 combo / multi‑miss)              | low | low | Parsed, not applied. Partial.                               |
| **Chord cohesion combo** (per‑row worst tap governs the row)               | low | med | Stepzone approximates per‑note (documented). Partial.      |
| Attacks (`#ATTACKS` — timed mid‑song modifiers)                            | med | low | Note type exists; not scheduled/applied. Partial.           |
| Keysound playback (notes trigger samples; BMS/keysounded charts)           | med | low | `keysoundIndex` parsed; no sample playback. Partial.        |
| Labels (`#LABELS` bookmarks) surfaced                                      | low | low | Parsed; editor/visual only. Partial.                        |
| Composite / **routine** (`&`‑separated) charts                             | med | low | Single‑player only today (tracked ROADMAP M6).              |
| Held‑miss tracking (ITG pad‑debug aid)                                     | low | low | ITGmania‑specific.                                          |
| Per‑player / per‑column timing‑window disable (ITGmania)                   | low | low | ITGmania‑specific.                                          |

## 4. Game types & styles

Stepzone input is **dance‑single (4 keys)** only, though it can _render/parse_ solo(6),
double(8), and pump(5) column layouts. ITGmania ships dance/pump/techno/lights.

| Gap                                                     | E       | P   | Notes                                             |
| ------------------------------------------------------- | ------- | --- | ------------------------------------------------- |
| **Doubles** (dance‑double, 8 panels, 1 player) playable | med     | med | Renders columns; no 8‑col input mapping. Partial. |
| **Pump** (5‑panel) playable + checkpoint holds          | med     | med | Renders arrows; no 5‑col input/judging. Partial.  |
| Solo (6‑panel) playable                                 | low     | low | Renders; no 6‑col input. Partial.                 |
| Techno game (single 4/5/8, double 4/5/8)                | low‑med | low |                                                   |
| Threepanel / couple / halfdouble styles                 | low     | low |                                                   |
| Lights (cabinet‑light) track                            | low     | low | Arcade lamps only.                                |

## 5. Game modes & courses

Stepzone does **single‑song play only** (`PLAY_MODE_REGULAR` equivalent). All other
`PlayMode`s and the course system are absent.

| Gap                                                             | E    | P       | Notes                                |
| --------------------------------------------------------------- | ---- | ------- | ------------------------------------ |
| Course parsing (`.crs`) + Trail resolution                      | med  | med     | Foundation for all course modes.     |
| **Nonstop** mode (fixed song set, back‑to‑back)                 | med  | med     |                                      |
| **Oni / Survival** (battery lives / draining time)              | med  | low‑med | Needs battery/time life (§2).        |
| Endless mode                                                    | low  | low     |                                      |
| Course wildcards + random / best / worst / grade‑best selection | med  | low     | `#SONGSELECT` criteria.              |
| Marathon / long‑song stage handling                             | low  | low     |                                      |
| Multi‑stage play (N songs per credit, extra stage)              | low  | low     |                                      |
| Workout mode (time/calorie goal‑driven course)                  | med  | low     |                                      |
| **Battle** mode (earn + manually throw attacks at opponent)     | high | low     |                                      |
| **Rave** mode (auto attacks, tug‑of‑war life)                   | high | low     |                                      |
| Versus multiplayer (2 players, 2 charts)                        | high | low     |                                      |
| **Routine** (2 players share one chart, alternating notes)      | high | low     | Needs `ScoreKeeperShared`, 2× input. |

## 6. Scoring & profiles

Stepzone stores a single **best** per chart (percent, grade, max combo, judgment
counts, play count) in `localStorage`, using DDR dance points + 6 letter grade tiers.

| Gap                                                                                                                          | E   | P   | Notes                                     |
| ---------------------------------------------------------------------------------------------------------------------------- | --- | --- | ----------------------------------------- |
| **ITG percentage / EX‑score** weighting (separate from DDR dance points)                                                     | low | med | ITG's displayed %. Partial: DDR % done.   |
| Grade system parity (ITG 20‑tier / theme grades, quad‑star, "AAAA")                                                          | low | med | Stepzone has 6 letters (AAA…D). Partial. |
| **High‑score lists** (top‑N per chart, not just best)                                                                        | low | med |                                           |
| Rich `HighScore` fields: date, mods used, radar values, survival secs, disqualified, awards                                  | low | med | Partial: minimal best kept.               |
| **Player profiles** (named), machine profile, guest profile                                                                  | med | med | Only anonymous localStorage today.        |
| Memory‑card / USB profile load (arcade)                                                                                      | low | low | Mostly N/A on web.                        |
| Machine vs. personal records; **Ranking screen**; ranking categories (A/B/C/D by meter)                                      | med | low |                                           |
| High‑score name entry                                                                                                        | low | low |                                           |
| Profile aggregate stats (totals by playmode/style/difficulty/meter; tap/jump/hold/mine totals; toasties; sessions; playtime) | med | low |                                           |
| Most‑played / recently‑played tracking                                                                                       | low | low |                                           |
| Calorie tracking (step‑ + heart‑rate‑based)                                                                                  | low | low |                                           |
| Goals (calories / time)                                                                                                      | low | low |                                           |
| Unlocks / codes                                                                                                              | low | low |                                           |
| Awards: StageAward (FC etc.), PeakComboAward                                                                                 | low | low |                                           |
| Screenshots with embedded score; signed/anti‑cheat stats                                                                     | low | low |                                           |

## 7. Editing / authoring

Stepzone has a read‑only Inspector. **No chart editor.**

| Gap                                                                             | E    | P       | Notes                            |
| ------------------------------------------------------------------------------- | ---- | ------- | -------------------------------- |
| Chart editor: place/remove taps, holds, rolls, mines, lifts, fakes              | high | low‑med | `ScreenEdit` core.               |
| Timing editing (BPM/stop/delay/warp/speed/scroll/tickcount/combo/label/fake)    | high | low     |                                  |
| Record mode (play notes in live)                                                | med  | low     |                                  |
| Selection ops: cut/copy/paste, quantize, turn, transform, tempo compress/expand | high | low     |                                  |
| Song / steps metadata editing                                                   | med  | low     |                                  |
| BGChange (`#BGCHANGES`) authoring                                               | med  | low     |                                  |
| Attack / keysound authoring                                                     | med  | low     |                                  |
| **Write `.sm`/`.ssc`/`.crs`** (round‑trip serialization + ChartKey hash)        | med  | low     | Tracked ROADMAP M6 (validation). |
| Autogen (auto‑generate steps / fill width)                                      | med  | low     |                                  |

## 8. Autoplay, replay & sync

Stepzone has an AdjustSync‑style **manual auto‑calibrate** offset screen.

| Gap                                                                         | E   | P       | Notes                                             |
| --------------------------------------------------------------------------- | --- | ------- | ------------------------------------------------- |
| Autoplay (perfect AI) + CPU skill levels (0–5, weighted from `AI.ini`)      | low | low‑med | Good demo/practice/attract mode.                  |
| In‑play AutoSync: song / machine / **tempo** (least‑squares BPM+offset fit) | med | low     | Partial: manual calibrate only.                   |
| Results **offset scatter / timing graph** (per‑tap offsets)                 | low | med     | Stepzone results show counts, no graph. Partial. |
| Life‑graph on results                                                       | low | med     | Tracked in ROADMAP as a richer results screen.    |
| Assist clap / metronome tick during gameplay                                | low | low     |                                                   |
| Replay save + playback                                                      | med | low     | ITGmania's own replay is a dormant stub.          |

## 9. Theming & visual

Stepzone uses a fixed **Canvas** renderer (quantization colors, arcade look), a React
UI, and static image/video backgrounds.

| Gap                                                                                              | E         | P   | Notes                                                                             |
| ------------------------------------------------------------------------------------------------ | --------- | --- | --------------------------------------------------------------------------------- |
| **Noteskins** (swappable arrow art, per‑game, variants, note/beat/vivid coloring)                | med       | med | Partial: quantization coloring wired.                                             |
| Song **preview playback** on select (`SAMPLESTART`/`SAMPLELENGTH`)                               | low       | med | Fields parsed; not played. Partial.                                               |
| **GPU / perspective renderer** (PixiJS/WebGPU) for effect & perspective mods, dense charts       | high      | med | Renderer sits behind one interface (ROADMAP). Enables §1 effect/perspective mods. |
| BGChanges: scripted/animated backgrounds, per‑beat visuals, foreground layer, random BG          | med       | low | Partial: static image/video only.                                                 |
| Lua‑scripted **theme layer** (all screens/menus/HUD as swappable actors + BGAnimations)          | very high | low | Architecturally different; Stepzone uses React/Canvas.                           |
| Announcer (voice / sound‑cue sets reacting to events)                                            | low       | low |                                                                                   |
| Gameplay flourishes: toasty, full‑combo/"hot" effects, hold flash, combo pulse, per‑judgment art | low       | low | Partial: basic HUD only.                                                          |
| Cabinet lights output                                                                            | low       | low |                                                                                   |

## 10. Input & hardware

Stepzone: rebindable **keyboard** (4 columns) + **gamepad** (dpad/left‑stick → 4 columns).

| Gap                                                                    | E    | P   | Notes                                                  |
| ---------------------------------------------------------------------- | ---- | --- | ------------------------------------------------------ |
| >4‑column input mapping (doubles / pump / solo)                        | med  | med | Keymap & gamepad are hard‑wired to 4 columns. Partial. |
| Rebindable **gamepad buttons** (arbitrary buttons, not just dpad/axes) | low  | med | Keyboard is rebindable; gamepad is fixed. Partial.     |
| Multiple simultaneous players / controllers (ITG MultiPlayer up to 32) | high | low |                                                        |
| Raw‑HID / dedicated‑pad support; per‑pad lights                        | high | low |                                                        |

## 11. Song library & navigation

Stepzone: load one pack; searchable/filterable table (type/meter/BPM, sort); favorites;
banners; expandable difficulty grid.

| Gap                                                                           | E   | P   | Notes                                                 |
| ----------------------------------------------------------------------------- | --- | --- | ----------------------------------------------------- |
| **Persist library across reloads** (File System Access API)                   | med | med | Re‑pick folder each session today (ROADMAP deferred). |
| Multi‑pack / song‑group browsing; a song **wheel**                            | med | med | Partial: single‑pack table.                           |
| Preview music on hover/select                                                 | low | med | See §9 (preview playback).                            |
| Grouping/sort parity (by group/artist/genre/BPM/difficulty/most‑played/grade) | low | low | Partial: some sorts present.                          |
| Random / roulette song select                                                 | low | low |                                                       |
| Course / nonstop selection UI                                                 | low | low | Depends on §5.                                        |

## 12. Networking & platform (mostly ITGmania‑specific additions vs. SM5)

Stepzone is fully offline/local.

| Gap                                                                                                   | E        | P       | Notes                                                          |
| ----------------------------------------------------------------------------------------------------- | -------- | ------- | -------------------------------------------------------------- |
| **GrooveStats** integration: chart hash (`#GROOVESTATSHASH`) + score submission + leaderboards/RPG/QR | med–high | low‑med | Popular in the ITG community; hash is cheap, full flow is not. |
| Built‑in networking (`NetworkManager`: HTTP + WebSocket, host allowlist)                              | high     | low     | ITGmania's headline feature; themes drive it.                  |
| Reload songs from the select screen                                                                   | low      | low     | ITGmania QoL addition.                                         |
| Operator/machine settings & global preferences surface                                                | low      | low     |                                                                |
| Per‑player **visual delay**, per‑column timing windows, note render‑order pref                        | low      | low     | ITGmania engine additions (some overlap §1/§3).                |

---

## Non‑gaps (already faithful — for reference)

To keep this honest, Stepzone already matches ITGmania on these, so they are **not**
future work: MSD tokenizing; `.sm`/`.ssc` header + note‑grid parsing (incl. the `,,`
quirk and keysound list); beat⇄second timing with BPM/stop/delay/warp; `.sm`
negative‑BPM/negative‑stop → warp synthesis; `.ssc` split (per‑chart) timing; W1–W5 +
mine/hold/roll windows with music‑rate scaling; DDR dance‑point weights and grade tiers;
per‑judgment life deltas; fail at life 0; mine detonation; lift‑on‑release; fake
exclusion; C/X/M scroll math; quantization note colors; and correct arrow directions for
single/solo/double/pump layouts. (Legacy games beat/kb7/para/pop'n/ez2/maniax are absent
from ITGmania itself, so they are out of scope entirely.)
