/**
 * A tiny grid world that implements the whole probe contract in memory.
 *
 * This is the fixture every detector is measured against, and it exists in a
 * healthy version plus four deliberately broken ones. That pairing is the only
 * honest test of a probe: a detector that fires on the broken variant proves
 * nothing unless it stays silent on the healthy one. "Does it find bugs?" is
 * half the question; "does it invent them?" is the other half.
 *
 * The world is deterministic — same inputs, same trace — even though the probe
 * never assumes that. Determinism here is a property of the test rig, not an
 * expectation of the system under test.
 *
 * Layout (40x24 cells of 32 world units):
 *   - a solid border, an open L-shaped play area, and a walled room in the
 *     bottom-right holding the goal, entered through one door cell
 *   - the avatar spawns top-left, drifts down under gravity, and is moved by
 *     left / right / jump
 *   - screenshots are synthesized as real PNGs whose picture tracks the avatar,
 *     so frame-hash novelty works when the entity sense is switched off
 *
 * Variants:
 *   healthy       nothing wrong
 *   broken-input  "right" is wired to nothing
 *   crash-at-100  throws on step 100
 *   softlock-pit  a floor region that freezes the avatar forever on contact
 *   sealed-room   the door cell is walled in, so the goal is unreachable
 */
import type {
  GameUnderTest,
  NavGrid,
  PointerKind,
  ProbeCapabilities,
  ProbeEntity,
  ProbeError,
  StepObservation,
} from '../contract.js';
import { blankImage, encodePng, fillRect, type RgbaImage } from '../png.js';
import { resolveEntityRef } from '../entities.js';

export type SyntheticVariant = 'healthy' | 'broken-input' | 'crash-at-100' | 'softlock-pit' | 'sealed-room';

export interface SyntheticOptions {
  /** Drop declared senses (and the matching methods) to test capability honesty. */
  senses?: Partial<ProbeCapabilities['senses']>;
  /** Drop declared inputs. */
  input?: Partial<ProbeCapabilities['input']>;
  /** Render every frame as flat black — for exercising the black-screen detector. */
  renderBlank?: boolean;
  /** Step at which crash-at-100 throws. */
  crashAt?: number;
}

const COLS = 40;
const ROWS = 24;
const CELL = 32;
/** Screenshot resolution: device pixels per world cell. */
const PX = 8;
/** Camera view size, in world cells. */
const VIEW_COLS = 20;
const VIEW_ROWS = 12;
/** Horizontal speed, world units per step. */
const SPEED = 6;
/** Downward drift per step — the reason every measurement subtracts a control window. */
const GRAVITY = 3;
/** Net vertical speed during the rising part of a jump. */
const JUMP_RISE = -6;
/**
 * Steps a single jump press keeps rising. A jump is an impulse, not a
 * hovercraft: holding the button forever must not beat gravity, or an avatar
 * that mashes jump would float at the ceiling and never touch the floor — and
 * every floor-based hazard (like the softlock pit) would be untestable.
 */
const JUMP_STEPS = 10;
/** How close the avatar must be to the goal to trigger it. */
const GOAL_RADIUS = 24;
/** World units travelled between progression events. */
const SCORE_STRIDE = 500;
/** Cap on progression events, so a long run cannot mint unbounded event names. */
const MAX_SCORE_EVENTS = 40;

const SPAWN = { x: 2.5 * CELL, y: 2.5 * CELL };
const GOAL = { x: 30.5 * CELL, y: 16.5 * CELL };
/** The one gap in the room's wall. */
const DOOR = { col: 18, row: 16 };

const COLORS = {
  wall: [58, 58, 68, 255],
  floor: [120, 122, 132, 255],
  decorA: [176, 168, 148, 255],
  decorB: [78, 96, 112, 255],
  pit: [18, 18, 22, 255],
  goal: [240, 200, 70, 255],
  avatar: [255, 255, 255, 255],
} satisfies Record<string, [number, number, number, number]>;

function buildSolids(sealed: boolean): boolean[] {
  const solid = new Array<boolean>(COLS * ROWS).fill(false);
  const set = (col: number, row: number, value: boolean): void => {
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
    solid[row * COLS + col] = value;
  };
  for (let c = 0; c < COLS; c++) {
    set(c, 0, true);
    set(c, ROWS - 1, true);
  }
  for (let r = 0; r < ROWS; r++) {
    set(0, r, true);
    set(COLS - 1, r, true);
  }
  // The room in the bottom-right: a vertical wall and a horizontal one.
  for (let r = 10; r < ROWS; r++) set(18, r, true);
  for (let c = 18; c < COLS; c++) set(c, 10, true);
  // Its only entrance — walled in for the sealed-room variant.
  set(DOOR.col, DOOR.row, sealed);
  return solid;
}

/**
 * Floor colour for a cell, constant per 4x4 block. Three tones is enough
 * structure for an average hash to tell one part of the map from another.
 */
function floorTone(col: number, row: number): [number, number, number, number] {
  const bc = Math.floor(col / 4);
  const br = Math.floor(row / 4);
  const mixed = (Math.imul(bc, 73856093) ^ Math.imul(br, 19349663)) >>> 0;
  const tone = mixed % 3;
  return tone === 0 ? COLORS.floor : tone === 1 ? COLORS.decorA : COLORS.decorB;
}

function buildPits(active: boolean): boolean[] {
  const pit = new Array<boolean>(COLS * ROWS).fill(false);
  if (!active) return pit;
  for (let r = 17; r <= 22; r++) {
    for (let c = 1; c <= 17; c++) pit[r * COLS + c] = true;
  }
  return pit;
}

class SyntheticGame {
  readonly capabilities: ProbeCapabilities;
  private readonly solid: boolean[];
  private readonly pit: boolean[];
  private readonly crashAt: number;
  private readonly held = new Map<string, boolean>();
  private x = SPAWN.x;
  private y = SPAWN.y;
  private frame = 0;
  private frozen = false;
  private goalReached = false;
  private jumping = false;
  private jumpLeft = 0;
  private distance = 0;
  private scored = 0;
  private running = false;

  constructor(
    private readonly variant: SyntheticVariant,
    private readonly options: SyntheticOptions,
  ) {
    this.solid = buildSolids(variant === 'sealed-room');
    this.pit = buildPits(variant === 'softlock-pit');
    this.crashAt = options.crashAt ?? 100;
    this.capabilities = {
      input: {
        actions: ['jump', 'left', 'right'],
        axes: [],
        pointer: true,
        ...options.input,
      },
      senses: {
        errors: true,
        scenes: true,
        events: true,
        entities: true,
        screenshot: true,
        nav: true,
        reset: true,
        states: false,
        ...options.senses,
      },
      viewport: { width: COLS * CELL, height: ROWS * CELL },
    };
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.restore();
  }

  async reset(): Promise<void> {
    this.restore();
  }

  private restore(): void {
    this.x = SPAWN.x;
    this.y = SPAWN.y;
    this.frame = 0;
    this.frozen = false;
    this.goalReached = false;
    this.jumping = false;
    this.jumpLeft = 0;
    this.distance = 0;
    this.scored = 0;
    this.held.clear();
  }

  async step(): Promise<StepObservation> {
    this.frame++;
    const newEvents: string[] = [];
    const newErrors: ProbeError[] = [];

    if (this.variant === 'crash-at-100' && this.frame === this.crashAt) {
      newErrors.push({
        message: "TypeError: Cannot read properties of undefined (reading 'x')",
        where: 'player.js:31',
        at: { frame: this.frame },
      });
    }

    if (!this.frozen) {
      const jump = this.held.get('jump') === true;
      if (jump && !this.jumping) {
        newEvents.push('jump-start');
        this.jumpLeft = JUMP_STEPS;
      }
      this.jumping = jump;
      const rising = jump && this.jumpLeft > 0;
      if (rising) this.jumpLeft--;
      let dx = 0;
      if (this.held.get('left')) dx -= SPEED;
      if (this.held.get('right') && this.variant !== 'broken-input') dx += SPEED;
      const before = { x: this.x, y: this.y };
      this.move(dx, rising ? JUMP_RISE : GRAVITY);
      // Progression: a game that is responding keeps producing new milestones.
      // A frozen avatar covers no ground, mints no events, and reads as stalled.
      this.distance += Math.abs(this.x - before.x) + Math.abs(this.y - before.y);
      const milestone = Math.floor(this.distance / SCORE_STRIDE);
      if (milestone > this.scored && milestone <= MAX_SCORE_EVENTS) {
        this.scored = milestone;
        newEvents.push(`score-${milestone}`);
      }
      if (this.pitAt(this.x, this.y)) this.frozen = true;
      if (!this.goalReached && Math.hypot(this.x - GOAL.x, this.y - GOAL.y) <= GOAL_RADIUS) {
        this.goalReached = true;
        newEvents.push('goal-reached');
      }
    }

    return {
      frame: this.frame,
      ms: this.frame * 16,
      newErrors,
      sceneId: this.capabilities.senses.scenes ? 'main' : null,
      newEvents: this.capabilities.senses.events ? newEvents : [],
    };
  }

  private move(dx: number, dy: number): void {
    const nx = this.x + dx;
    if (!this.solidAt(nx, this.y)) this.x = nx;
    const ny = this.y + dy;
    if (!this.solidAt(this.x, ny)) this.y = ny;
  }

  private cellOf(x: number, y: number): number {
    const col = Math.floor(x / CELL);
    const row = Math.floor(y / CELL);
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return -1;
    return row * COLS + col;
  }

  private solidAt(x: number, y: number): boolean {
    const index = this.cellOf(x, y);
    return index < 0 || this.solid[index];
  }

  private pitAt(x: number, y: number): boolean {
    const index = this.cellOf(x, y);
    return index >= 0 && this.pit[index];
  }

  async setActionDown(name: string): Promise<void> {
    this.held.set(name, true);
  }

  async setActionUp(name: string): Promise<void> {
    this.held.set(name, false);
  }

  async setAxis(_name: string, _value: number): Promise<void> {
    // The fixture declares no axes; accepting the call keeps adapters honest.
  }

  async sendPointer(_x: number, _y: number, _kind: PointerKind): Promise<void> {
    // Pointer input has no effect in this world; it exists so mash has a surface.
  }

  async listEntities(): Promise<ProbeEntity[]> {
    return [
      { id: 'avatar', name: 'Avatar', tags: ['player'], x: this.x, y: this.y, alive: true },
      { id: 'goal', name: 'Goal', tags: ['goal'], x: GOAL.x, y: GOAL.y, alive: !this.goalReached },
      { id: 'prop-a', name: 'Crate', tags: ['prop'], x: 5.5 * CELL, y: 22.5 * CELL, alive: true },
      { id: 'prop-b', name: 'Torch', tags: ['prop'], x: 12.5 * CELL, y: 3.5 * CELL, alive: true },
    ];
  }

  async findEntity(ref: string): Promise<ProbeEntity | null> {
    return resolveEntityRef(await this.listEntities(), ref);
  }

  async navGrid(): Promise<NavGrid | null> {
    return {
      originX: 0,
      originY: 0,
      cellSize: CELL,
      cols: COLS,
      rows: ROWS,
      solid: [...this.solid],
    };
  }

  async screenshot(): Promise<Uint8Array> {
    return encodePng(this.render());
  }

  /**
   * The frame as pixels — a camera view centered on the avatar, like almost
   * every real game draws.
   *
   * This matters for the probe, not for the fixture's own physics. An 8x8
   * average hash of a FIXED camera with a small sprite on it is essentially
   * blind: the walls dominate every downsampled cell and the player moving
   * across the whole world shifts one or two bits. A following camera makes the
   * whole picture move with the player, which is what gives the pixel-only
   * novelty path something real to read — and it is what an adapter screen-
   * shotting an actual game will be handed.
   */
  render(): RgbaImage {
    const img = blankImage(VIEW_COLS * PX, VIEW_ROWS * PX, [0, 0, 0, 255]);
    if (this.options.renderBlank) return img;
    const originCol = Math.round(this.x / CELL) - Math.floor(VIEW_COLS / 2);
    const originRow = Math.round(this.y / CELL) - Math.floor(VIEW_ROWS / 2);
    for (let vr = 0; vr < VIEW_ROWS; vr++) {
      for (let vc = 0; vc < VIEW_COLS; vc++) {
        const col = originCol + vc;
        const row = originRow + vr;
        const outside = col < 0 || col >= COLS || row < 0 || row >= ROWS;
        const index = row * COLS + col;
        let color: [number, number, number, number];
        if (outside || this.solid[index]) color = COLORS.wall;
        else if (this.pit[index]) color = COLORS.pit;
        // Deterministic floor tiling. A featureless room hashes identically
        // from every position, so the art is what makes one place
        // distinguishable from another. The pattern varies per 4x4 cell block
        // on purpose: anything finer averages away in the 8x8 hash downsample,
        // which is exactly the trap a real fixed-camera game with one small
        // sprite falls into.
        else color = floorTone(col, row);
        fillRect(img, vc * PX, vr * PX, PX, PX, color);
      }
    }
    const goalCol = Math.floor(GOAL.x / CELL) - originCol;
    const goalRow = Math.floor(GOAL.y / CELL) - originRow;
    if (goalCol >= 0 && goalCol < VIEW_COLS && goalRow >= 0 && goalRow < VIEW_ROWS) {
      fillRect(img, goalCol * PX, goalRow * PX, PX, PX, COLORS.goal);
    }
    fillRect(img, Math.floor(VIEW_COLS / 2) * PX, Math.floor(VIEW_ROWS / 2) * PX, PX, PX, COLORS.avatar);
    return img;
  }

}

/**
 * A GameUnderTest for the given variant. Optional methods are present exactly
 * when the matching capability is declared, so stripping a sense really does
 * take the method away — the same contract an adapter has to satisfy.
 */
export function makeSynthetic(
  variant: SyntheticVariant = 'healthy',
  options: SyntheticOptions = {},
): GameUnderTest {
  const game = new SyntheticGame(variant, options);
  const senses = game.capabilities.senses;
  return {
    capabilities: game.capabilities,
    start: () => game.start(),
    stop: () => game.stop(),
    step: () => game.step(),
    setActionDown: (name) => game.setActionDown(name),
    setActionUp: (name) => game.setActionUp(name),
    setAxis: (name, value) => game.setAxis(name, value),
    sendPointer: (x, y, kind) => game.sendPointer(x, y, kind),
    ...(senses.entities
      ? { listEntities: () => game.listEntities(), findEntity: (ref: string) => game.findEntity(ref) }
      : {}),
    ...(senses.screenshot ? { screenshot: () => game.screenshot() } : {}),
    ...(senses.nav ? { navGrid: () => game.navGrid() } : {}),
    ...(senses.reset ? { reset: () => game.reset() } : {}),
  };
}

/** The fixture's world constants, for tests that need to reason about geometry. */
export const SYNTHETIC_WORLD = {
  cols: COLS,
  rows: ROWS,
  cellSize: CELL,
  spawn: SPAWN,
  goal: GOAL,
  door: DOOR,
  pixelsPerCell: PX,
  viewCols: VIEW_COLS,
  viewRows: VIEW_ROWS,
} as const;
