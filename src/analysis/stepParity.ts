/**
 * A faithful TypeScript port of ITGmania's StepParity foot-assignment solver and
 * TechCounts classifier (src/StepParity*.cpp, src/TechCounts.cpp — MIT, (c) 2023
 * Michael Votaw). It assigns each note to a foot (left/right heel/toe) by finding
 * the least-cost path through a per-row state graph, then derives the tech counts
 * (Crossovers, Footswitches, Sideswitches, Jacks, Brackets) from that assignment.
 *
 * The port mirrors the C++ line for line — same cost weights and thresholds, same
 * permutation order, same state-cache keys and tie-breaking — so the counts match
 * the game exactly. Validated against the compiled C++ on the ITGmania song
 * library (see scripts/techValidate.ts). Only the Lua bindings are omitted.
 *
 * Input is the game's own NoteData + TimingData; supported for dance-single and
 * dance-double (the only layouts ITGmania models).
 */

import type { NoteData } from '../notes/noteData';
import { noteRowToBeat, TapNoteType } from '../notes/noteTypes';
import type { TimingData } from '../timing/timingData';

// --- Foot parts (StepParity::Foot) -------------------------------------------
const NONE = 0;
const LH = 1;
const LT = 2;
const RH = 3;
const RT = 4;
const NUM_FOOT = 5;
const FEET = [LH, LT, RH, RT] as const;
const OTHER_PART = [NONE, LT, LH, RT, RH];
const FOOT_MASKS = [0, 1, 2, 4, 8];
const INVALID = -1;

// ITGmania does all StepParity geometry and cost math in 32-bit `float`. We
// emulate that with Math.fround at every step so the least-cost path (and thus
// the counts) match exactly — a hard threshold like the bracket check
// (sqrt(2)*sqrt(2) <= 2) and near-tie cost comparisons are precision-sensitive.
const f = Math.fround;

// --- Cost weights (StepParityCost.h) -----------------------------------------
const DOUBLESTEP = 850;
const BRACKETJACK = 20;
const JACK = 30;
const SLOW_BRACKET = 300;
const TWISTED_FOOT = 100000;
const BRACKETTAP = 400;
const HOLDSWITCH = 55;
const MINE = 10000;
const FOOTSWITCH = 325;
const MISSED_FOOTSWITCH = 500;
const FACING = 2;
const DISTANCE = 6;
const SPIN = 1000;
const SIDESWITCH = 130;
const JACK_THRESHOLD = 0.1;
const SLOW_BRACKET_THRESHOLD = 0.15;
const SLOW_FOOTSWITCH_THRESHOLD = 0.2;
const SLOW_FOOTSWITCH_IGNORE = 0.4;

const TNT_EMPTY = TapNoteType.Empty;
const TNT_TAP = TapNoteType.Tap;
const TNT_HOLD = TapNoteType.HoldHead;
const TNT_MINE = TapNoteType.Mine;
const TNT_FAKE = TapNoteType.Fake;
const TNT_AUTOKEY = TapNoteType.AutoKeysound;

interface StagePoint {
  x: number;
  y: number;
}

interface IntermediateNote {
  type: number;
  beat: number;
  holdLength: number; // beats; -1 for non-holds
  fake: boolean;
  second: number;
}

function emptyNote(): IntermediateNote {
  return { type: TNT_EMPTY, beat: 0, holdLength: -1, fake: false, second: 0 };
}

// ============================================================================
// StageLayout
// ============================================================================

// The facing penalties are the only values ITGmania derives with pow() — and
// V8's pow rounds its last bit differently from MSVC's, which can flip a near-tie
// path. But they depend solely on the fixed stage geometry, so they're constants:
// the exact native float32 values, dumped from the compiled C++ (indexed
// left*columnCount + right). Hardcoding them removes the last transcendental from
// the per-chart path — everything else is sqrt (IEEE correctly-rounded) and
// float32 arithmetic, so the solver is now bit-identical to the game.
// prettier-ignore
const FX_SINGLE = [0, 0, 0, 0, 8.24692345, 0, 0, 0, 8.24692345, 0, 0, 0, 100, 8.24692345, 8.24692345, 0];
// prettier-ignore
const FY_SINGLE = [0, 8.24692345, 0, 0, 0, 0, 0, 0, 8.24692345, 100, 0, 8.24692345, 0, 8.24692345, 0, 0];
// prettier-ignore
const FX_DOUBLE = [0, 0, 0, 0, 0, 0, 0, 0, 8.24692345, 0, 0, 0, 0, 0, 0, 0, 8.24692345, 0, 0, 0, 0, 0, 0, 0, 100, 8.24692345, 8.24692345, 0, 0, 0, 0, 0, 100, 44.7841072, 44.7841072, 100, 0, 0, 0, 0, 80.3925781, 100, 26.6119728, 44.7841072, 8.24692345, 0, 0, 0, 80.3925781, 26.6119728, 100, 44.7841072, 8.24692345, 0, 0, 0, 100, 80.3925781, 80.3925781, 100, 100, 8.24692345, 8.24692345, 0];
// prettier-ignore
const FY_DOUBLE = [0, 8.24692345, 0, 0, 0, 0.00371863903, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 8.24692345, 100, 0, 8.24692345, 0.304584622, 1.43621647, 0, 0.00371863903, 0, 8.24692345, 0, 0, 0, 0.304584622, 0, 0, 0, 0.304584622, 0, 0, 0, 8.24692345, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.00371863903, 1.43621647, 0, 0.304584622, 8.24692345, 100, 0, 8.24692345, 0, 0.00371863903, 0, 0, 0, 8.24692345, 0, 0];

class StageLayout {
  columns: StagePoint[];
  columnCount: number;
  upArrows: number[];
  downArrows: number[];
  sideArrows: number[];
  private avgPoints: StagePoint[] = [];
  private distances: number[] = [];
  private facingXPenalties: number[] = [];
  private facingYPenalties: number[] = [];
  /** mask (note|hold) -> list of foot placements. */
  permuteCache = new Map<number, number[][]>();

  constructor(
    cols: StagePoint[],
    up: number[],
    down: number[],
    side: number[],
    fx: number[],
    fy: number[],
  ) {
    this.columns = cols;
    this.columnCount = cols.length;
    this.upArrows = up;
    this.downArrows = down;
    this.sideArrows = side;
    // Native float32 facing penalties (see FX_/FY_ above); fround to land on the
    // exact float32 the game holds.
    this.facingXPenalties = fx.map(f);
    this.facingYPenalties = fy.map(f);
    this.preCalculateStuff();
    this.preGeneratePermutations();
  }

  bracketCheck(c1: number, c2: number): boolean {
    const dist = this.getDistance(c1, c2);
    return f(dist * dist) <= 2;
  }
  getDistanceSq(c1: number, c2: number): number {
    const p1 = this.columns[c1];
    const p2 = this.columns[c2];
    return f(f(p1.y - p2.y) * f(p1.y - p2.y) + f(p1.x - p2.x) * f(p1.x - p2.x));
  }
  getDistance(l: number, r: number): number {
    if (l === INVALID || r === INVALID) return 0;
    return this.distances[l * this.columnCount + r];
  }
  getXFacingPenalty(l: number, r: number): number {
    if (l === INVALID || r === INVALID) return 0;
    return this.facingXPenalties[l * this.columnCount + r];
  }
  getYFacingPenalty(l: number, r: number): number {
    if (l === INVALID || r === INVALID) return 0;
    return this.facingYPenalties[l * this.columnCount + r];
  }
  averagePoint(l: number, r: number): StagePoint {
    if (l === INVALID && r === INVALID) return { x: 0, y: 0 };
    if (l === INVALID) return this.columns[r];
    if (r === INVALID) return this.columns[l];
    return this.avgPoints[l * this.columnCount + r];
  }

  private preCalculateStuff(): void {
    const n = this.columnCount;
    for (let left = 0; left < n; left++) {
      for (let right = 0; right < n; right++) {
        const idx = left * n + right;
        this.avgPoints[idx] = {
          x: f((this.columns[left].x + this.columns[right].x) / 2),
          y: f((this.columns[left].y + this.columns[right].y) / 2),
        };
        const dx = f(this.columns[left].x - this.columns[right].x);
        const dy = f(this.columns[left].y - this.columns[right].y);
        this.distances[idx] = f(Math.sqrt(f(f(dx * dx) + f(dy * dy))));
      }
    }
  }

  private preGeneratePermutations(): void {
    this.permuteCache.set(0, []);
    const n = this.columnCount;
    for (let i = 0; i < Math.pow(2, n); i++) {
      let bits = 0;
      for (let b = i; b; b >>= 1) bits += b & 1;
      if (bits > 4) continue;
      const placements = this.permuteFootPlacements(i, new Array(n).fill(NONE), 0);
      if (placements.length > 0) this.permuteCache.set(i, placements);
    }
  }

  private permuteFootPlacements(mask: number, test: number[], column: number): number[][] {
    if (column >= test.length) {
      let lh = INVALID;
      let lt = INVALID;
      let rh = INVALID;
      let rt = INVALID;
      for (let i = 0; i < test.length; i++) {
        if (test[i] === NONE) continue;
        if (test[i] === LH) lh = i;
        if (test[i] === LT) lt = i;
        if (test[i] === RH) rh = i;
        if (test[i] === RT) rt = i;
      }
      if ((lh === INVALID && lt !== INVALID) || (rh === INVALID && rt !== INVALID)) return [];
      if (lh !== INVALID && lt !== INVALID && !this.bracketCheck(lh, lt)) return [];
      if (rh !== INVALID && rt !== INVALID && !this.bracketCheck(rh, rt)) return [];
      return [test.slice()];
    }
    const active = (mask & (0x1 << column)) !== 0;
    if (active) {
      const out: number[][] = [];
      for (const foot of FEET) {
        if (test.indexOf(foot) !== -1) continue;
        const next = test.slice();
        next[column] = foot;
        const p = this.permuteFootPlacements(mask, next, column + 1);
        for (const x of p) out.push(x);
      }
      return out;
    }
    return this.permuteFootPlacements(mask, test, column + 1);
  }
}

const LAYOUT_SINGLE = new StageLayout(
  [
    { x: 0, y: 1 },
    { x: 1, y: 0 },
    { x: 1, y: 2 },
    { x: 2, y: 1 },
  ],
  [2],
  [1],
  [0, 3],
  FX_SINGLE,
  FY_SINGLE,
);
const LAYOUT_DOUBLE = new StageLayout(
  [
    { x: 0, y: 1 },
    { x: 1, y: 0 },
    { x: 1, y: 2 },
    { x: 2, y: 1 },
    { x: 3, y: 1 },
    { x: 4, y: 0 },
    { x: 4, y: 2 },
    { x: 5, y: 1 },
  ],
  [2, 6],
  [1, 5],
  [0, 3, 4, 7],
  FX_DOUBLE,
  FY_DOUBLE,
);

function layoutFor(stepsType: string): StageLayout | null {
  if (stepsType === 'dance-single' || stepsType === 'techno-single4') return LAYOUT_SINGLE;
  if (stepsType === 'dance-double' || stepsType === 'dance-couple' || stepsType === 'dance-routine')
    return LAYOUT_DOUBLE;
  return null;
}

// ============================================================================
// State / Row
// ============================================================================

class State {
  combinedColumns: number[];
  movedMask = 0;
  holdingMask = 0;
  combinedMask = 0;
  whereTheFeetAre = new Array(NUM_FOOT).fill(INVALID);
  whatNoteTheFootIsHitting = new Array(NUM_FOOT).fill(INVALID);
  didTheFootMove = new Array(NUM_FOOT).fill(false);
  isTheFootHolding = new Array(NUM_FOOT).fill(false);
  constructor(columnCount: number) {
    this.combinedColumns = new Array(columnCount).fill(NONE);
  }
}

class Row {
  notes: IntermediateNote[];
  holds: IntermediateNote[];
  mines: number[];
  fakeMines: number[];
  columns: number[];
  whereTheFeetAre = new Array(NUM_FOOT).fill(INVALID);
  noteMask = 0;
  holdMask = 0;
  mineMask = 0;
  fakeMineMask = 0;
  second = 0;
  beat = 0;
  rowIndex = 0;
  columnCount: number;
  noteCount = 0;
  constructor(columnCount: number) {
    this.columnCount = columnCount;
    this.notes = Array.from({ length: columnCount }, emptyNote);
    this.holds = Array.from({ length: columnCount }, emptyNote);
    this.mines = new Array(columnCount).fill(0);
    this.fakeMines = new Array(columnCount).fill(0);
    this.columns = new Array(columnCount).fill(NONE);
  }
  setFootPlacement(state: State): void {
    for (let c = 0; c < this.columnCount; c++) {
      if (this.notes[c].type !== TNT_EMPTY) {
        this.columns[c] = state.combinedColumns[c];
        this.whereTheFeetAre[state.combinedColumns[c]] = c;
        this.noteCount += 1;
      }
    }
  }
}

interface RowCounter {
  notes: IntermediateNote[];
  activeHolds: IntermediateNote[];
  lastColumnSecond: number;
  lastColumnBeat: number;
  mines: number[];
  fakeMines: number[];
  nextMines: number[];
  nextFakeMines: number[];
}

const CLM_INVALID = -1;

interface Node {
  id: number;
  state: State;
  second: number;
  totalCost: number;
  previousNode: Node | null;
}

// ============================================================================
// Cost model (StepParityCost.cpp)
// ============================================================================

class Cost {
  constructor(private layout: StageLayout) {}

  getActionCost(
    initial: State,
    result: State,
    row: Row,
    previousRow: Row | null,
    columns: number[],
    elapsedTime: number,
  ): number {
    const columnCount = row.columnCount;
    let cost = 0;

    const leftHeel = result.whatNoteTheFootIsHitting[LH];
    const leftToe = result.whatNoteTheFootIsHitting[LT];
    const rightHeel = result.whatNoteTheFootIsHitting[RH];
    const rightToe = result.whatNoteTheFootIsHitting[RT];

    const movedLeft = result.didTheFootMove[LH] || result.didTheFootMove[LT];
    const movedRight = result.didTheFootMove[RH] || result.didTheFootMove[RT];

    const didJump =
      ((initial.didTheFootMove[LH] && !initial.isTheFootHolding[LH]) ||
        (initial.didTheFootMove[LT] && !initial.isTheFootHolding[LT])) &&
      ((initial.didTheFootMove[RH] && !initial.isTheFootHolding[RH]) ||
        (initial.didTheFootMove[RT] && !initial.isTheFootHolding[RT]));

    const jackedLeft = this.didJackLeft(initial, result, leftHeel, leftToe, movedLeft, didJump);
    const jackedRight = this.didJackRight(
      initial,
      result,
      rightHeel,
      rightToe,
      movedRight,
      didJump,
    );

    cost = f(cost + this.calcMineCost(result, row, columnCount));
    cost = f(cost + this.calcHoldSwitchCost(initial, result, row, columnCount));
    cost = f(
      cost +
        this.calcBracketTapCost(initial, row, leftHeel, leftToe, rightHeel, rightToe, elapsedTime),
    );
    cost = f(
      cost +
        this.calcBracketJackCost(result, movedLeft, movedRight, jackedLeft, jackedRight, didJump),
    );
    cost = f(
      cost +
        this.calcDoublestepCost(
          initial,
          result,
          row,
          previousRow,
          movedLeft,
          movedRight,
          jackedLeft,
          jackedRight,
          didJump,
        ),
    );
    cost = f(cost + this.calcSlowBracketCost(row, movedLeft, movedRight, elapsedTime));
    cost = f(cost + this.calcTwistedFootCost(result));
    cost = f(cost + this.calcFacingCosts(result));
    cost = f(cost + this.calcSpinCosts(initial, result));
    cost = f(cost + this.calcFootswitchCost(initial, columns, row, elapsedTime, columnCount));
    cost = f(cost + this.calcSideswitchCost(initial, result, columns));
    cost = f(cost + this.calcMissedFootswitchCost(row, jackedLeft, jackedRight));
    cost = f(cost + this.calcJackCost(movedLeft, movedRight, jackedLeft, jackedRight, elapsedTime));
    cost = f(cost + this.calcBigMovementsQuicklyCost(initial, result, elapsedTime));
    return cost;
  }

  private calcMineCost(result: State, row: Row, columnCount: number): number {
    if (row.mineMask === 0 && row.fakeMineMask === 0) return 0;
    let cost = 0;
    for (let i = 0; i < columnCount; i++) {
      if (result.combinedColumns[i] !== NONE && (row.mines[i] !== 0 || row.fakeMines[i] !== 0)) {
        cost += MINE;
        break;
      }
    }
    return cost;
  }

  private calcHoldSwitchCost(initial: State, result: State, row: Row, columnCount: number): number {
    if (row.holdMask === 0) return 0;
    let cost = 0;
    for (let c = 0; c < columnCount; c++) {
      if (row.holds[c].type === TNT_EMPTY) continue;
      const rc = result.combinedColumns[c];
      const ic = initial.combinedColumns[c];
      if (
        ((rc === LH || rc === LT) && ic !== LT && ic !== LH) ||
        ((rc === RH || rc === RT) && ic !== RT && ic !== RH)
      ) {
        const previousFoot = initial.whereTheFeetAre[rc];
        cost = f(
          cost +
            f(
              HOLDSWITCH *
                (previousFoot === INVALID
                  ? 1
                  : f(Math.sqrt(this.layout.getDistanceSq(c, previousFoot)))),
            ),
        );
      }
    }
    return cost;
  }

  private calcBracketTapCost(
    initial: State,
    row: Row,
    leftHeel: number,
    leftToe: number,
    rightHeel: number,
    rightToe: number,
    elapsedTime: number,
  ): number {
    if (row.holdMask === 0) return 0;
    let cost = 0;
    if (leftHeel !== INVALID && leftToe !== INVALID) {
      let jackPenalty = 1;
      if (initial.didTheFootMove[LH] || initial.didTheFootMove[LT])
        jackPenalty = f(1 / elapsedTime);
      if (row.holds[leftHeel].type !== TNT_EMPTY && row.holds[leftToe].type === TNT_EMPTY)
        cost = f(cost + f(BRACKETTAP * jackPenalty));
      if (row.holds[leftToe].type !== TNT_EMPTY && row.holds[leftHeel].type === TNT_EMPTY)
        cost = f(cost + f(BRACKETTAP * jackPenalty));
    }
    if (rightHeel !== INVALID && rightToe !== INVALID) {
      let jackPenalty = 1;
      if (initial.didTheFootMove[RT] || initial.didTheFootMove[RH])
        jackPenalty = f(1 / elapsedTime);
      if (row.holds[rightHeel].type !== TNT_EMPTY && row.holds[rightToe].type === TNT_EMPTY)
        cost = f(cost + f(BRACKETTAP * jackPenalty));
      if (row.holds[rightToe].type !== TNT_EMPTY && row.holds[rightHeel].type === TNT_EMPTY)
        cost = f(cost + f(BRACKETTAP * jackPenalty));
    }
    return cost;
  }

  private calcBracketJackCost(
    result: State,
    movedLeft: boolean,
    movedRight: boolean,
    jackedLeft: boolean,
    jackedRight: boolean,
    didJump: boolean,
  ): number {
    if (movedLeft === movedRight || result.holdingMask !== 0 || didJump) return 0;
    let cost = 0;
    if (jackedLeft && result.didTheFootMove[LH] && result.didTheFootMove[LT]) cost += BRACKETJACK;
    if (jackedRight && result.didTheFootMove[RH] && result.didTheFootMove[RT]) cost += BRACKETJACK;
    return cost;
  }

  private calcDoublestepCost(
    initial: State,
    result: State,
    row: Row,
    previousRow: Row | null,
    movedLeft: boolean,
    movedRight: boolean,
    jackedLeft: boolean,
    jackedRight: boolean,
    didJump: boolean,
  ): number {
    if (movedLeft === movedRight || result.holdingMask !== 0 || didJump) return 0;
    let cost = 0;
    if (
      this.didDoubleStep(initial, row, previousRow, movedLeft, jackedLeft, movedRight, jackedRight)
    )
      cost += DOUBLESTEP;
    return cost;
  }

  private calcSlowBracketCost(
    row: Row,
    movedLeft: boolean,
    movedRight: boolean,
    elapsedTime: number,
  ): number {
    let cost = 0;
    if (elapsedTime > SLOW_BRACKET_THRESHOLD && movedLeft !== movedRight) {
      let notes = 0;
      for (const n of row.notes) if (n.type !== TNT_EMPTY) notes++;
      if (notes >= 2) cost = f(cost + f(f(elapsedTime - SLOW_BRACKET_THRESHOLD) * SLOW_BRACKET));
    }
    return cost;
  }

  private calcTwistedFootCost(result: State): number {
    let cost = 0;
    const leftHeel = result.whatNoteTheFootIsHitting[LH];
    const leftToe = result.whatNoteTheFootIsHitting[LT];
    const rightHeel = result.whatNoteTheFootIsHitting[RH];
    const rightToe = result.whatNoteTheFootIsHitting[RT];
    const leftPos = this.layout.averagePoint(leftHeel, leftToe);
    const rightPos = this.layout.averagePoint(rightHeel, rightToe);
    const crossedOver = rightPos.x < leftPos.x;
    const rightBackwards =
      rightHeel !== INVALID && rightToe !== INVALID
        ? this.layout.columns[rightToe].y < this.layout.columns[rightHeel].y
        : false;
    const leftBackwards =
      leftHeel !== INVALID && leftToe !== INVALID
        ? this.layout.columns[leftToe].y < this.layout.columns[leftHeel].y
        : false;
    if (!crossedOver && (rightBackwards || leftBackwards)) cost += TWISTED_FOOT;
    return cost;
  }

  private calcMissedFootswitchCost(row: Row, jackedLeft: boolean, jackedRight: boolean): number {
    let cost = 0;
    if ((jackedLeft || jackedRight) && (row.mineMask !== 0 || row.fakeMineMask !== 0))
      cost += MISSED_FOOTSWITCH;
    return cost;
  }

  private calcFacingCosts(result: State): number {
    let endLeftHeel = result.whereTheFeetAre[LH];
    let endLeftToe = result.whereTheFeetAre[LT];
    let endRightHeel = result.whereTheFeetAre[RH];
    let endRightToe = result.whereTheFeetAre[RT];
    if (endLeftToe === INVALID) endLeftToe = endLeftHeel;
    if (endRightToe === INVALID) endRightToe = endRightHeel;
    const heel = f(this.layout.getXFacingPenalty(endLeftHeel, endRightHeel) * FACING);
    const toes = f(this.layout.getXFacingPenalty(endLeftToe, endRightToe) * FACING);
    const left = f(this.layout.getYFacingPenalty(endLeftHeel, endLeftToe) * FACING);
    const right = f(this.layout.getYFacingPenalty(endRightHeel, endRightToe) * FACING);
    return f(f(f(heel + toes) + left) + right);
  }

  private calcSpinCosts(initial: State, result: State): number {
    let cost = 0;
    let endLeftHeel = result.whereTheFeetAre[LH];
    let endLeftToe = result.whereTheFeetAre[LT];
    let endRightHeel = result.whereTheFeetAre[RH];
    let endRightToe = result.whereTheFeetAre[RT];
    if (endLeftToe === INVALID) endLeftToe = endLeftHeel;
    if (endRightToe === INVALID) endRightToe = endRightHeel;
    const previousLeftPos = this.layout.averagePoint(
      initial.whereTheFeetAre[LH],
      initial.whereTheFeetAre[LT],
    );
    const previousRightPos = this.layout.averagePoint(
      initial.whereTheFeetAre[RH],
      initial.whereTheFeetAre[RT],
    );
    const leftPos = this.layout.averagePoint(endLeftHeel, endLeftToe);
    const rightPos = this.layout.averagePoint(endRightHeel, endRightToe);
    if (
      rightPos.x < leftPos.x &&
      previousRightPos.x < previousLeftPos.x &&
      rightPos.y < leftPos.y &&
      previousRightPos.y > previousLeftPos.y
    )
      cost += SPIN;
    if (
      rightPos.x < leftPos.x &&
      previousRightPos.x < previousLeftPos.x &&
      rightPos.y > leftPos.y &&
      previousRightPos.y < previousLeftPos.y
    )
      cost += SPIN;
    return cost;
  }

  private calcFootswitchCost(
    initial: State,
    columns: number[],
    row: Row,
    elapsedTime: number,
    columnCount: number,
  ): number {
    if (elapsedTime < SLOW_FOOTSWITCH_THRESHOLD || elapsedTime >= SLOW_FOOTSWITCH_IGNORE) return 0;
    if (row.mineMask !== 0 || row.fakeMineMask !== 0) return 0;
    let cost = 0;
    const timeScaled = f(elapsedTime - SLOW_FOOTSWITCH_THRESHOLD);
    for (let i = 0; i < columnCount; i++) {
      if (initial.combinedColumns[i] === NONE || columns[i] === NONE) continue;
      if (
        initial.combinedColumns[i] !== columns[i] &&
        initial.combinedColumns[i] !== OTHER_PART[columns[i]]
      ) {
        cost = f(cost + f(f(timeScaled / f(SLOW_FOOTSWITCH_THRESHOLD + timeScaled)) * FOOTSWITCH));
        break;
      }
    }
    return cost;
  }

  private calcSideswitchCost(initial: State, result: State, columns: number[]): number {
    let cost = 0;
    for (const c of this.layout.sideArrows) {
      if (
        initial.combinedColumns[c] !== columns[c] &&
        columns[c] !== NONE &&
        initial.combinedColumns[c] !== NONE &&
        !result.didTheFootMove[initial.combinedColumns[c]]
      )
        cost += SIDESWITCH;
    }
    return cost;
  }

  private calcJackCost(
    movedLeft: boolean,
    movedRight: boolean,
    jackedLeft: boolean,
    jackedRight: boolean,
    elapsedTime: number,
  ): number {
    let cost = 0;
    if (elapsedTime < JACK_THRESHOLD && movedLeft !== movedRight) {
      const timeScaled = f(JACK_THRESHOLD - elapsedTime);
      if (jackedLeft || jackedRight)
        cost = f(cost + f(f(f(1 / timeScaled) - f(1 / JACK_THRESHOLD)) * JACK));
    }
    return cost;
  }

  private calcBigMovementsQuicklyCost(initial: State, result: State, elapsedTime: number): number {
    let cost = 0;
    for (const foot of FEET) {
      if ((result.movedMask & FOOT_MASKS[foot]) === 0) continue;
      const initialPosition = initial.whereTheFeetAre[foot];
      if (initialPosition === INVALID) continue;
      const resultPosition = result.whatNoteTheFootIsHitting[foot];
      const isBracketing = result.whatNoteTheFootIsHitting[OTHER_PART[foot]] !== INVALID;
      if (isBracketing && result.whatNoteTheFootIsHitting[OTHER_PART[foot]] === initialPosition)
        continue;
      let dist = f(
        f(this.layout.getDistance(initialPosition, resultPosition) * DISTANCE) / elapsedTime,
      );
      if (isBracketing) dist = f(dist * 0.2);
      cost = f(cost + dist);
    }
    return cost;
  }

  private didDoubleStep(
    initial: State,
    row: Row,
    previousRow: Row | null,
    movedLeft: boolean,
    jackedLeft: boolean,
    movedRight: boolean,
    jackedRight: boolean,
  ): boolean {
    let doublestepped = false;
    if (
      movedLeft &&
      !jackedLeft &&
      ((initial.didTheFootMove[LH] && !initial.isTheFootHolding[LH]) ||
        (initial.didTheFootMove[LT] && !initial.isTheFootHolding[LT]))
    )
      doublestepped = true;
    if (
      movedRight &&
      !jackedRight &&
      ((initial.didTheFootMove[RH] && !initial.isTheFootHolding[RH]) ||
        (initial.didTheFootMove[RT] && !initial.isTheFootHolding[RT]))
    )
      doublestepped = true;
    if (previousRow !== null) {
      for (const hold of previousRow.holds) {
        if (hold.type === TNT_EMPTY) continue;
        const endBeat = row.beat;
        const startBeat = previousRow.beat;
        const holdEnd = f(hold.beat + hold.holdLength);
        if (holdEnd > startBeat && holdEnd < endBeat) doublestepped = false;
        if (holdEnd >= endBeat) doublestepped = false;
      }
    }
    return doublestepped;
  }

  private didJackLeft(
    initial: State,
    result: State,
    leftHeel: number,
    leftToe: number,
    movedLeft: boolean,
    didJump: boolean,
  ): boolean {
    let jacked = false;
    if (!didJump && movedLeft) {
      if (
        leftHeel > INVALID &&
        initial.combinedColumns[leftHeel] === LH &&
        !result.isTheFootHolding[LH] &&
        ((initial.didTheFootMove[LH] && !initial.isTheFootHolding[LH]) ||
          (initial.didTheFootMove[LT] && !initial.isTheFootHolding[LT]))
      )
        jacked = true;
      if (
        leftToe > INVALID &&
        initial.combinedColumns[leftToe] === LT &&
        !result.isTheFootHolding[LT] &&
        ((initial.didTheFootMove[LH] && !initial.isTheFootHolding[LH]) ||
          (initial.didTheFootMove[LT] && !initial.isTheFootHolding[LT]))
      )
        jacked = true;
    }
    return jacked;
  }

  private didJackRight(
    initial: State,
    result: State,
    rightHeel: number,
    rightToe: number,
    movedRight: boolean,
    didJump: boolean,
  ): boolean {
    let jacked = false;
    if (!didJump && movedRight) {
      if (
        rightHeel > INVALID &&
        initial.combinedColumns[rightHeel] === RH &&
        !result.isTheFootHolding[RH] &&
        ((initial.didTheFootMove[RH] && !initial.isTheFootHolding[RH]) ||
          (initial.didTheFootMove[RT] && !initial.isTheFootHolding[RT]))
      )
        jacked = true;
      if (
        rightToe > INVALID &&
        initial.combinedColumns[rightToe] === RT &&
        !result.isTheFootHolding[RT] &&
        ((initial.didTheFootMove[RH] && !initial.isTheFootHolding[RH]) ||
          (initial.didTheFootMove[RT] && !initial.isTheFootHolding[RT]))
      )
        jacked = true;
    }
    return jacked;
  }
}

// ============================================================================
// Generator (StepParityGenerator.cpp)
// ============================================================================

class Generator {
  private stateCache = new Map<number, State>();
  private nodes: Node[] = [];
  rows: Row[] = [];
  private columnCount = 0;
  private startNode: Node | null = null;
  private endNode: Node | null = null;

  constructor(
    private layout: StageLayout,
    private timing: TimingData,
  ) {}

  analyze(nd: NoteData): boolean {
    this.columnCount = nd.numTracks;
    this.createRows(nd);
    if (this.rows.length === 0) return false;
    this.buildStateGraph();
    return this.analyzeGraph();
  }

  private analyzeGraph(): boolean {
    const path = this.computeCheapestPath();
    if (path.length !== this.rows.length) return false;
    for (let i = 0; i < this.rows.length; i++) {
      this.rows[i].setFootPlacement(this.nodes[path[i]].state);
    }
    return true;
  }

  private createRows(nd: NoteData): void {
    const columnCount = nd.numTracks;
    // Flatten to (row, col) in ascending (row, col) order — ITGmania's
    // all-tracks iterator order.
    const flat: Array<{
      row: number;
      col: number;
      note: { type: number; subType: number; durationRows: number };
    }> = [];
    for (let c = 0; c < columnCount; c++) {
      for (const rn of nd.getTrack(c)) flat.push({ row: rn.row, col: c, note: rn.note });
    }
    flat.sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));

    const counter: RowCounter = {
      notes: Array.from({ length: columnCount }, emptyNote),
      activeHolds: Array.from({ length: columnCount }, emptyNote),
      lastColumnSecond: CLM_INVALID,
      lastColumnBeat: CLM_INVALID,
      mines: new Array(columnCount).fill(0),
      fakeMines: new Array(columnCount).fill(0),
      nextMines: new Array(columnCount).fill(0),
      nextFakeMines: new Array(columnCount).fill(0),
    };

    for (const { row: smRow, col, note: tn } of flat) {
      const type = tn.type as number;
      // Timing lookup uses the full-precision beat (as the game's TimingData
      // does); the stored beat is float32 for the doublestep hold math, and the
      // second is float32 (ITGmania's TimingData returns float).
      const note: IntermediateNote = {
        type,
        beat: f(noteRowToBeat(smRow)),
        holdLength: type === TNT_HOLD ? f(noteRowToBeat(tn.durationRows)) : -1,
        fake: type === TNT_FAKE || this.timing.isFakeAtRow(smRow),
        second: f(this.timing.getElapsedTimeFromBeat(noteRowToBeat(smRow))),
      };

      if (type === TNT_EMPTY || type === TNT_AUTOKEY) continue;

      if (type === TNT_MINE) {
        if (note.second === counter.lastColumnSecond && this.rows.length > 0) {
          if (note.fake) counter.nextFakeMines[col] = note.second;
          else counter.nextMines[col] = note.second;
        } else {
          if (note.fake) counter.fakeMines[col] = note.second;
          else counter.mines[col] = note.second;
        }
        continue;
      }

      if (note.fake) continue;

      if (counter.lastColumnSecond !== note.second) {
        if (counter.lastColumnSecond !== CLM_INVALID) this.addRow(counter);
        counter.lastColumnSecond = note.second;
        counter.lastColumnBeat = note.beat;
        counter.nextMines = counter.mines.slice();
        counter.nextFakeMines = counter.fakeMines.slice();
        counter.notes = Array.from({ length: columnCount }, emptyNote);
        counter.mines = new Array(columnCount).fill(0);
        counter.fakeMines = new Array(columnCount).fill(0);
        for (let c = 0; c < columnCount; c++) {
          if (
            counter.activeHolds[c].type === TNT_EMPTY ||
            note.beat > f(counter.activeHolds[c].beat + counter.activeHolds[c].holdLength)
          )
            counter.activeHolds[c] = emptyNote();
        }
      }

      counter.notes[col] = note;
      if (type === TNT_HOLD) counter.activeHolds[col] = note;
    }
    this.addRow(counter);
  }

  private addRow(counter: RowCounter): void {
    const row = this.createRow(counter);
    row.rowIndex = this.rows.length;
    this.rows.push(row);
  }

  private createRow(counter: RowCounter): Row {
    const row = new Row(this.columnCount);
    for (let c = 0; c < this.columnCount; c++) row.notes[c] = counter.notes[c];
    row.mines = counter.nextMines.slice();
    row.fakeMines = counter.nextFakeMines.slice();
    row.second = counter.lastColumnSecond;
    row.beat = counter.lastColumnBeat;
    for (let c = 0; c < this.columnCount; c++) {
      if (
        counter.activeHolds[c].type === TNT_EMPTY ||
        counter.activeHolds[c].second >= counter.lastColumnSecond
      )
        row.holds[c] = emptyNote();
      else row.holds[c] = counter.activeHolds[c];

      const bit = 0x1 << c;
      if (row.notes[c].type === TNT_TAP || row.notes[c].type === TNT_HOLD) row.noteMask |= bit;
      if (row.holds[c].type !== TNT_EMPTY) row.holdMask |= bit;
      if (row.mines[c] !== 0) row.mineMask |= bit;
      if (row.fakeMines[c] !== 0) row.fakeMineMask |= bit;
    }
    return row;
  }

  private getFootPlacementPermutations(row: Row): number[][] {
    const cacheKey = row.noteMask | row.holdMask;
    let p = this.layout.permuteCache.get(cacheKey);
    if (p === undefined) p = this.layout.permuteCache.get(row.noteMask);
    if (p === undefined) return this.layout.permuteCache.get(0)!;
    return p;
  }

  private getStateCacheKey(state: State): number {
    // combined_mask (<=24 bits) + moved<<30 + holding<<46, built with arithmetic
    // (JS bitwise is 32-bit).
    return state.combinedMask + state.movedMask * 0x40000000 + state.holdingMask * 0x400000000000;
  }

  private initResultState(initial: State, row: Row, columns: number[]): State {
    const result = new State(this.columnCount);
    for (let i = 0; i < columns.length; i++) {
      if (columns[i] === NONE) continue;
      result.whatNoteTheFootIsHitting[columns[i]] = i;
      if (row.holds[i].type === TNT_EMPTY) {
        result.didTheFootMove[columns[i]] = true;
        continue;
      }
      if (initial.combinedColumns[i] !== columns[i]) result.didTheFootMove[columns[i]] = true;
    }
    for (let i = 0; i < columns.length; i++) {
      if (columns[i] === NONE) continue;
      if (row.holds[i].type !== TNT_EMPTY) result.isTheFootHolding[columns[i]] = true;
      const bit = 0x1 << i;
      const footMask = FOOT_MASKS[columns[i]];
      if ((row.holdMask & bit) !== 0) result.holdingMask |= footMask;
      if ((row.holdMask & bit) === 0 || initial.combinedColumns[i] !== columns[i])
        result.movedMask |= footMask;
    }
    this.mergeInitialAndResultPosition(initial, result, columns, columns.length);

    const key = this.getStateCacheKey(result);
    const cached = this.stateCache.get(key);
    if (cached !== undefined) return cached;
    this.stateCache.set(key, result);
    return result;
  }

  private mergeInitialAndResultPosition(
    initial: State,
    result: State,
    columns: number[],
    columnCount: number,
  ): void {
    for (let i = 0; i < columnCount; i++) {
      if (columns[i] !== NONE) {
        result.combinedColumns[i] = columns[i];
        continue;
      }
      const ic = initial.combinedColumns[i];
      if (ic === LH || ic === RH) {
        if (!result.didTheFootMove[ic]) result.combinedColumns[i] = ic;
      } else if (ic === LT) {
        if (!result.didTheFootMove[LT] && !result.didTheFootMove[LH])
          result.combinedColumns[i] = ic;
      } else if (ic === RT) {
        if (!result.didTheFootMove[RT] && !result.didTheFootMove[RH])
          result.combinedColumns[i] = ic;
      }
    }
    for (let i = 0; i < columnCount; i++) {
      if (result.combinedColumns[i] !== NONE) result.whereTheFeetAre[result.combinedColumns[i]] = i;
      result.combinedMask |= result.combinedColumns[i] << (i * 3);
    }
  }

  private addNode(state: State, second: number): Node {
    const node: Node = {
      id: this.nodes.length,
      state,
      second,
      totalCost: 0,
      previousNode: null,
    };
    this.nodes.push(node);
    return node;
  }

  private buildStateGraph(): void {
    const beginningState = new State(this.columnCount);
    this.startNode = this.addNode(beginningState, f(this.rows[0].second - 1));
    let previousNodes: Node[] = [this.startNode];
    const cost = new Cost(this.layout);

    for (let i = 0; i < this.rows.length; i++) {
      const stateMap = new Map<number, Node>();
      const resultNodes: Node[] = [];
      const row = this.rows[i];
      const permutations = this.getFootPlacementPermutations(row);

      for (const initialNode of previousNodes) {
        const elapsedTime = f(row.second - initialNode.second);
        for (const perm of permutations) {
          const resultState = this.initResultState(initialNode.state, row, perm);
          const previousRow = i > 0 ? this.rows[i - 1] : null;
          const c = cost.getActionCost(
            initialNode.state,
            resultState,
            row,
            previousRow,
            perm,
            elapsedTime,
          );
          const key = this.getStateCacheKey(resultState);
          const existing = stateMap.get(key);
          if (existing !== undefined) {
            const totalCost = f(initialNode.totalCost + c);
            if (totalCost < existing.totalCost) {
              existing.totalCost = totalCost;
              existing.previousNode = initialNode;
            }
          } else {
            const newNode = this.addNode(resultState, row.second);
            newNode.totalCost = f(initialNode.totalCost + c);
            newNode.previousNode = initialNode;
            stateMap.set(key, newNode);
            resultNodes.push(newNode);
          }
        }
      }
      previousNodes = resultNodes;
    }

    const endingState = new State(this.columnCount);
    this.endNode = this.addNode(endingState, f(this.rows[this.rows.length - 1].second + 1));
    this.endNode.totalCost = Infinity;
    for (const node of previousNodes) {
      if (node.totalCost < this.endNode.totalCost) {
        this.endNode.totalCost = node.totalCost;
        this.endNode.previousNode = node;
      }
    }
  }

  private computeCheapestPath(): number[] {
    let current = this.endNode!.previousNode;
    if (current === null) return [];
    const path: number[] = [];
    while (current !== this.startNode && current !== null) {
      path.push(current.id);
      current = current.previousNode;
    }
    if (current === null) return [];
    path.reverse();
    return path;
  }
}

// ============================================================================
// TechCounts classification (TechCounts.cpp)
// ============================================================================

const JACK_CUTOFF = 0.176;
const FOOTSWITCH_CUTOFF = 0.3;

export interface TechCounts {
  crossovers: number;
  footswitches: number;
  sideswitches: number;
  jacks: number;
  brackets: number;
}

function isFootswitch(c: number, cur: Row, prev: Row, elapsedTime: number): boolean {
  if (cur.columns[c] === NONE || prev.columns[c] === NONE) return false;
  return (
    prev.columns[c] !== cur.columns[c] &&
    OTHER_PART[prev.columns[c]] !== cur.columns[c] &&
    elapsedTime < FOOTSWITCH_CUTOFF
  );
}

function classify(rows: Row[], layout: StageLayout): TechCounts {
  const t: TechCounts = { crossovers: 0, footswitches: 0, sideswitches: 0, jacks: 0, brackets: 0 };
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    if (cur.noteCount >= 2) {
      if (cur.whereTheFeetAre[LH] !== INVALID && cur.whereTheFeetAre[LT] !== INVALID) t.brackets++;
      if (cur.whereTheFeetAre[RH] !== INVALID && cur.whereTheFeetAre[RT] !== INVALID) t.brackets++;
    }
    if (i === 0) continue;
    const prev = rows[i - 1];
    const elapsedTime = cur.second - prev.second;

    if (cur.noteCount === 1 && prev.noteCount === 1) {
      for (const foot of FEET) {
        if (cur.whereTheFeetAre[foot] === INVALID || prev.whereTheFeetAre[foot] === INVALID)
          continue;
        if (prev.whereTheFeetAre[foot] === cur.whereTheFeetAre[foot] && elapsedTime < JACK_CUTOFF)
          t.jacks++;
      }
    }

    for (const c of layout.upArrows) if (isFootswitch(c, cur, prev, elapsedTime)) t.footswitches++;
    for (const c of layout.downArrows)
      if (isFootswitch(c, cur, prev, elapsedTime)) t.footswitches++;
    for (const c of layout.sideArrows)
      if (isFootswitch(c, cur, prev, elapsedTime)) t.sideswitches++;

    const leftHeel = cur.whereTheFeetAre[LH];
    const leftToe = cur.whereTheFeetAre[LT];
    const rightHeel = cur.whereTheFeetAre[RH];
    const rightToe = cur.whereTheFeetAre[RT];
    const prevLeftHeel = prev.whereTheFeetAre[LH];
    const prevLeftToe = prev.whereTheFeetAre[LT];
    const prevRightHeel = prev.whereTheFeetAre[RH];
    const prevRightToe = prev.whereTheFeetAre[RT];

    if (rightHeel !== INVALID && prevLeftHeel !== INVALID && prevRightHeel === INVALID) {
      const leftPos = layout.averagePoint(prevLeftHeel, prevLeftToe);
      const rightPos = layout.averagePoint(rightHeel, rightToe);
      if (rightPos.x < leftPos.x) {
        if (i > 1) {
          const ppRightHeel = rows[i - 2].whereTheFeetAre[RH];
          if (ppRightHeel !== INVALID && ppRightHeel !== rightHeel) t.crossovers++;
        } else {
          t.crossovers++;
        }
      }
    } else if (leftHeel !== INVALID && prevRightHeel !== INVALID && prevLeftHeel === INVALID) {
      const leftPos = layout.averagePoint(leftHeel, leftToe);
      const rightPos = layout.averagePoint(prevRightHeel, prevRightToe);
      if (rightPos.x < leftPos.x) {
        if (i > 1) {
          const ppLeftHeel = rows[i - 2].whereTheFeetAre[LH];
          if (ppLeftHeel !== INVALID && ppLeftHeel !== leftHeel) t.crossovers++;
        } else {
          t.crossovers++;
        }
      }
    }
  }
  return t;
}

/** Whether tech counts are modelled for this steps-type. */
export function techSupported(stepsType: string): boolean {
  return layoutFor(stepsType) !== null;
}

/** Compute ITGmania-exact tech counts for a chart, or null if unsupported. */
export function computeTechCounts(
  nd: NoteData,
  timing: TimingData,
  stepsType: string,
): TechCounts | null {
  const layout = layoutFor(stepsType);
  if (!layout) return null;
  const gen = new Generator(layout, timing);
  if (!gen.analyze(nd))
    return { crossovers: 0, footswitches: 0, sideswitches: 0, jacks: 0, brackets: 0 };
  return classify(gen.rows, layout);
}
