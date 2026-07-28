/**
 * `@hearth/adapter-web` — the probe's web adapter.
 *
 * Satisfies `@hearth/probe-core`'s `GameUnderTest` contract for any local web
 * game, with zero required conventions: point it at a directory or a URL and
 * it can inject input, capture screenshots and collect errors. Games that opt
 * in by installing the reference shim (`shim/probe-shim.js`, spec in
 * `docs/probe-shim.md`) get deeper senses — entities, scenes, events, nav,
 * fast reset — declared honestly through `capabilities`.
 */
export {
  openWebGame,
  actionNamesFrom,
  axisNamesFrom,
  formatLocation,
  isBrowserNoise,
  isDuplicateError,
  normalizeEntities,
  normalizeErrorMessage,
  normalizeNavGrid,
  resolveEntity,
  whereFromStack,
  DEFAULT_ACTION_KEYS,
  DEFAULT_STEP_MS,
  DEFAULT_VIEWPORT,
  PROBE_SHIM_PATH,
  type OpenWebGameOptions,
  type WebGameUnderTest,
} from './adapter.js';

export {
  openStatic,
  serveDir,
  useUrl,
  contentTypeFor,
  resolveRequestPath,
  type StaticServer,
} from './server.js';

export {
  canLaunchChromium,
  launchChromium,
  startScreencast,
  CHROMIUM_MISSING_ERROR,
  SCREENCAST_INTERVAL_MS,
  SCREENCAST_MAX_EDGE,
  SCREENCAST_QUALITY,
  type PwBrowser,
  type PwPage,
} from './chromium.js';
