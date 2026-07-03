/**
 * Pure helper for merging `window.__HEARTH_BOOT__` into `HearthPlayer.boot()`
 * options. Split out from ./index.ts (which assigns `window.HearthPlayer` at
 * module scope and so can only be imported in a browser) so this piece of
 * logic is importable and unit-testable headlessly.
 */

/** Subset of BootOptions a host may stage on window.__HEARTH_BOOT__ before the player script runs. */
export interface BootOverrides {
  manual?: boolean;
  seed?: number;
  debug?: boolean;
  width?: number;
  height?: number;
  /** Scene id or name to boot into (default: the project's initialScene). */
  scene?: string;
}

/**
 * Merge `window.__HEARTH_BOOT__` into explicit boot() options — explicit
 * options win for any key both set. This is the seam a screenshot/test
 * harness uses to drive manual/seeded/debug mode into an export's unmodified
 * `window.HearthPlayer.boot({ mount, bundle })` auto-boot call (see
 * exportCommands.ts's index.html template) without editing the template.
 */
export function mergeBootOverrides<T extends BootOverrides>(
  opts: T,
  overrides: BootOverrides | undefined,
): T {
  if (!overrides) return opts;
  return {
    ...opts,
    manual: opts.manual ?? overrides.manual,
    seed: opts.seed ?? overrides.seed,
    debug: opts.debug ?? overrides.debug,
    width: opts.width ?? overrides.width,
    height: opts.height ?? overrides.height,
    scene: opts.scene ?? overrides.scene,
  };
}
