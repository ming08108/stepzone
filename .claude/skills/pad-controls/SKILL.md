---
name: pad-controls
description: Core UX invariant for stepzone — every screen and core action must be fully operable with a dance pad (4 arrows + Start + Select, 6 inputs). How input maps to those 6, how to design flows within them, and how to verify pad-only.
---

# Dance-pad controllability

**Invariant: all core functionality must be reachable with a dance pad —
4 arrows + Start + Select, and nothing else.** A player at an arcade cabinet or
on a home pad has no mouse and no keyboard. Any flow that can only be completed
with a click or a typed key is a bug, not a convenience gap.

This is a design constraint on _every_ menu/UI change, not a feature. When you
add a screen, an action, or a mode, the first question is "how does a pad reach
this?" — before layout, before styling.

## The six inputs

The unified input bus (`src/input/inputBus.ts`) speaks `ControlRole`
(`src/input/controls.ts`): `up` `down` `left` `right` `confirm` `back`. That is
the whole vocabulary. Map from the physical pad:

- **4 arrows** → `up` / `down` / `left` / `right`
- **Start** → `confirm`
- **Select** → `back`

Gamepad button defaults (`DEFAULT_GAMEPAD_BUTTONS` in `src/input/gamepad.ts`,
standard mapping): left `[0,14]`, down `[3,13]`, up `[2,12]`, right `[1,15]`,
confirm/Start `[10,9]`, back/Select `[11,8]`.

Menu screens don't listen to the bus directly — `useGamepadKeys`
(`src/ui/useGamepadKeys.ts`) bridges each gamepad role to a synthetic keydown so
the existing keyboard handlers drive everything with no duplication:

| role               | key                     |
| ------------------ | ----------------------- |
| up/down/left/right | ArrowUp/Down/Left/Right |
| confirm (Start)    | Enter                   |
| back (Select)      | Escape                  |

**Consequence for testing:** driving those six keys _is_ driving the pad. A
keyboard test of a menu exercises the exact code path the pad hits. (Custom
keybinds resolve through `keyboardRole(code)`; gameplay column keys are separate.)

## Designing within six buttons

Six inputs is tight. A screen typically spends the 4 arrows on navigation
(2D grid, or list + a secondary axis like difficulty), leaving **only Start and
Select** for actions. So:

- **`confirm` (Start) = the primary forward action** — open / select / play.
- **`back` (Select) = go up a level OR open the menu** — pick one per screen and
  make it consistent. It's the single overloaded button, so when a screen needs
  _both_ "up a level" and "options", fold them together: **Select opens a menu,
  and the menu's first (pre-highlighted) row is the back/up action.** Then
  Select→Start steps back, and every other option is one nudge away. (This is how
  the song list's SELECT menu leads with `BACK ‹ PACKS`; see `SongSelect.tsx`,
  `overlayRows` / `activateRow`.)
- **Don't strand actions on a screen with no free button.** If a screen's 4
  arrows and Start/Select are all spoken for, the extra action belongs in the
  Select menu, not on a 7th binding that doesn't exist.
- **The root screen has no "up".** At a top-level screen (e.g. the pack grid)
  `back` has nowhere to go — either open the menu or leave it inert; never a
  dead-end that looks like it should do something.
- **Returning from a sub-flow lands where you left** (persist selection), so the
  pad user isn't re-navigating from the top after every song.

## Core vs. mouse-only

Everything a player needs to _pick a song, set options, and play_ is core and
must be pad-operable: pack/song navigation, difficulty, the sort/filter menu,
player options, starting, and quitting a song (hold-to-quit on `back`).

A few power-user conveniences are legitimately mouse/keyboard-only because a pad
can't express them and a player never needs them mid-session: **typing** in the
search box, **folder/source management** (adding song folders), and the gear
Options. Keep those reachable by mouse, but never put anything _core_ behind
them — e.g. the pack grid keeps SEARCH as a mouse affordance but does its actual
filtering-free navigation entirely on the pad.

## Verify pad-only

Prefer the keyboard proxy for menus (same code path — see the `verify` skill for
the headless-Chrome harness). To prove the _actual_ gamepad path end to end,
inject a virtual standard-mapping pad and drive its buttons:

```js
await page.addInitScript(() => {
  const pad = {
    index: 0,
    id: 'Virtual',
    connected: true,
    timestamp: 0,
    mapping: 'standard',
    buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0, touched: false })),
    axes: [0, 0, 0, 0],
  };
  window.__pad = pad;
  navigator.getGamepads = () => [pad, null, null, null];
  window.__press = (i) => {
    pad.buttons[i] = { pressed: true, value: 1, touched: true };
    pad.timestamp = performance.now();
  };
  window.__release = (i) => {
    pad.buttons[i] = { pressed: false, value: 0, touched: false };
    pad.timestamp = performance.now();
  };
});
// after load, the bus polls on rAF once it sees a pad:
await page.evaluate(() => window.dispatchEvent(new Event('gamepadconnected')));
const tap = async (i) => {
  await page.evaluate((b) => window.__press(b), i);
  await page.waitForTimeout(120);
  await page.evaluate((b) => window.__release(b), i);
  await page.waitForTimeout(180);
};
// dpad Right = 15, Left = 14, Up = 12, Down = 13, Start = 9, Select = 8
```

`GamepadEvent` won't accept a plain object — dispatch a bare `Event('gamepadconnected')`
(the bus's connect handler only triggers a poll; it doesn't read the event's gamepad).

**Checklist for any menu/nav change:** can a pad, from a cold start, reach this
screen, operate every action on it, and get back out — using only the 4 arrows,
Start, and Select? If any step needs a click or a typed key for a _core_ action,
it isn't done.
