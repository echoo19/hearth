/**
 * Which agents this machine can actually talk to, and how to fix it when it
 * can't.
 *
 * Two providers, authenticated in completely different ways:
 *
 *  - **Anthropic** — an API key, held by Hearth in `.hearth/app.json` (or the
 *    environment). The key never leaves the server process; the client only
 *    learns whether one exists and where it came from.
 *  - **OpenAI** — a ChatGPT sign-in (OAuth, driven through codex's own
 *    `account/login/start`) or an API key. Either way the CREDENTIAL IS
 *    CODEX'S, living in `~/.codex/auth.json`. Hearth never reads it, never
 *    proxies it, and never sends it anywhere; it reads a status and shows it.
 *
 * The status is a plain read-out, not a health check with opinions: `installed`
 * / `loggedIn` / `authMode` are facts, and the UI decides what to offer. Every
 * failure collapses into a renderable state rather than an exception, because
 * "the agent backend is unreachable" must never take the app down.
 *
 * `providerBus` exists because provider status changes from TWO directions —
 * an HTTP call (saving a key, starting a sign-in) and an out-of-band browser
 * OAuth completion — while the thing that must learn about it is the
 * WebSocket. Emitting on the bus lets projectServer.ts stay HTTP-shaped and
 * ws.ts stay socket-shaped without either importing the other.
 */
import { EventEmitter } from 'node:events';
import { forgetClaudeAuth, readClaudeAuth, SIGNED_OUT, type ClaudeAuth } from './claudeAuth.js';
import { forgetClaudeModels, readClaudeModels } from './claudeModels.js';
import { readAppSettings, resolveApiKey, type ChatProvider } from './chat.js';
import { CODEX_INSTALL_HINT, readCodexStatus, startCodexLogin, type CodexStatus } from './chatDrivers/codex.js';

export { CODEX_INSTALL_HINT };

/** One reasoning effort a model accepts, as its own backend declared it. */
export interface ProviderEffortOption {
  id: string;
  description?: string;
}

/**
 * One model a provider offers, in the words the selector shows.
 *
 * The optional half is the backend's own catalogue entry and is only ever as
 * full as that backend is willing to say. Codex answers all of it from
 * `model/list`; Claude answers most of it from `supportedModels()` on a query
 * handle (see claudeModels.ts), and neither of them reports everything. A
 * field that is absent means "this backend didn't say", and the picker's
 * answer to that is to offer no control — never to invent one.
 */
export interface ProviderModelInfo {
  /** Wire id. The empty string means "whatever the provider defaults to". */
  id: string;
  /**
   * The canonical model this row's `id` resolves to, when the backend says.
   *
   * Claude's catalogue is ALIASES (`sonnet`, `opus[1m]`, `default`), and the
   * SDK ships this field so a host can match a stored explicit id against the
   * alias row that covers it. Without it, a choice saved as
   * `claude-sonnet-5` matched no row at all: nothing ticked in the menu, and
   * no effort dial, because the efforts live on the row that was never found.
   */
  resolvedModel?: string;
  label: string;
  note?: string;
  /** The backend's own one-line description of the model. */
  description?: string;
  /** This is the model the backend picks when the turn names none. */
  isDefault?: boolean;
  /** Efforts THIS model accepts. Absent = it has no effort dial to offer. */
  efforts?: ProviderEffortOption[];
  /** The effort it uses when the turn names none. */
  defaultEffort?: string;
}

/**
 * The Anthropic fallback list, used when the real catalogue cannot be had (no
 * SDK installed, nobody signed in, or a CLI that will not answer
 * `supportedModels()`). Curated, and deliberately kept: a picker with no models
 * in it at all while a spawn settles is worse than three good answers.
 *
 * These rows carry no efforts, because a hardcoded list cannot know — which
 * models have an effort dial is per model and per account, and the live
 * catalogue in claudeModels.ts is the only thing that knows.
 */
export const ANTHROPIC_MODELS: ProviderModelInfo[] = [
  { id: 'claude-opus-5', label: 'Opus 5', note: 'Most capable' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5', note: 'Balanced' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', note: 'Fastest' },
];

/**
 * The OpenAI fallback list, used when the codex binary can't be asked (not
 * installed, signed out, or a build without `model/list`). The real list comes
 * from the binary — see readCodexStatus's `withModels`.
 */
export const OPENAI_FALLBACK_MODELS: ProviderModelInfo[] = [{ id: '', label: 'Default' }];

/**
 * The selector's OpenAI list: whatever the binary reported, always led by the
 * empty-id row so the user can hand the choice back to codex's own config.
 * That row is the one entry here that is ours rather than the binary's — the
 * client names it (see `modelGroups`), so both providers word it the same way.
 */
export function openAiModels(status: CodexStatus): ProviderModelInfo[] {
  const probed = status.models ?? [];
  if (probed.length === 0) return OPENAI_FALLBACK_MODELS;
  return [{ id: '', label: 'Default' }, ...probed];
}

/** GET /api/chat/providers — the whole picture, in one read. */
export interface ChatProviderStatus {
  anthropic: {
    hasKey: boolean;
    source: 'project' | 'environment' | null;
    /**
     * The Claude Code CLI is on this machine, which is an answer to "can
     * Claude reply here" all on its own. The SDK runs that CLI, and the CLI
     * authenticates with whatever the person signed into, so a key is one way
     * in rather than the way in. Reporting only `hasKey` told people with a
     * working Claude that it was not set up.
     */
    cli: boolean;
    /**
     * The CLI has an account. THIS is what decides whether Claude can answer,
     * not `cli` above: a machine with claude installed and nobody signed into
     * it used to report itself ready, offer its models, and fail the turn.
     */
    loggedIn: boolean;
    /** The signed-in account, when the CLI says. */
    email: string | null;
    /** The plan word, verbatim from the CLI (`max`, `pro`, ...). */
    planType: string | null;
    models?: ProviderModelInfo[];
  };
  openai: CodexStatus & { models?: ProviderModelInfo[] };
  /** Which provider a turn sent right now would actually go to. */
  active: ChatProvider | null;
}

/**
 * Emits `changed` with `{ root, status }` whenever a provider's state moves.
 * ws.ts fans that out to every window on the folder, so a sign-in completed in
 * a browser tab updates Settings without anyone pressing refresh.
 */
export const providerBus = new EventEmitter();

/** Where the Anthropic key came from, matching the existing settings read-out. */
/**
 * Is the Claude Code CLI on this machine?
 *
 * Injectable because it is a fact about the DEVELOPER'S machine as much as the
 * user's, and a test whose answer changes depending on whether whoever runs it
 * has claude installed is a test that will fail on somebody else's laptop and
 * on CI. The codex half of this file already learned that lesson: the test
 * beside it points `codexPath` at a file that does not exist for exactly the
 * same reason.
 */
export type ClaudeCliProbe = () => Promise<ClaudeAuth>;

/**
 * The live Claude catalogue, injectable for the same reason the sign-in probe
 * above is: the real one opens the SDK and talks to the CLI, so a test that
 * used it would answer differently on a machine that has claude than on one
 * that does not.
 */
export type ClaudeModelProbe = () => Promise<ProviderModelInfo[]>;

const detectClaudeCli: ClaudeCliProbe = readClaudeAuth;
const detectClaudeModels: ClaudeModelProbe = readClaudeModels;

async function anthropicStatus(
  projectRoot: string,
  probe: ClaudeCliProbe = detectClaudeCli,
  modelProbe: ClaudeModelProbe = detectClaudeModels,
): Promise<ChatProviderStatus['anthropic']> {
  const auth = await probe().catch(() => SIGNED_OUT);
  const account = {
    cli: auth.installed,
    loggedIn: auth.loggedIn,
    email: auth.email,
    planType: auth.planType,
    // Only ask when there is something to ask. The catalogue belongs to the
    // signed-in ACCOUNT, so a machine with no claude on it (or nobody signed
    // into the one it has) would pay for a spawn to be told nothing — the same
    // gate codex's `model/list` sits behind.
    models: await claudeModels(auth, modelProbe),
  };
  const stored = (await readAppSettings(projectRoot)).apiKey?.trim();
  if (stored) return { hasKey: true, source: 'project', ...account };
  const key = await resolveApiKey(projectRoot);
  return key
    ? { hasKey: true, source: 'environment', ...account }
    : { hasKey: false, source: null, ...account };
}

/**
 * The real list when it lands, the curated one when it doesn't. Empty is the
 * only signal claudeModels.ts gives for "couldn't be had", and every way that
 * happens means the same thing here.
 */
async function claudeModels(auth: ClaudeAuth, probe: ClaudeModelProbe): Promise<ProviderModelInfo[]> {
  if (!auth.installed || !auth.loggedIn) return ANTHROPIC_MODELS;
  const probed = await probe().catch(() => []);
  return probed.length > 0 ? probed : ANTHROPIC_MODELS;
}

/**
 * Read both providers. Never throws — a codex binary that hangs or a protocol
 * change degrades to "installed, signed out" rather than a failed request.
 */
export async function readChatProviders(
  projectRoot: string,
  opts?: { claudeCli?: ClaudeCliProbe; claudeModels?: ClaudeModelProbe },
): Promise<ChatProviderStatus> {
  const [anthropic, openai] = await Promise.all([
    anthropicStatus(projectRoot, opts?.claudeCli, opts?.claudeModels).catch(
      () =>
        ({
          hasKey: false,
          source: null,
          cli: false,
          loggedIn: false,
          email: null,
          planType: null,
          models: ANTHROPIC_MODELS,
        }) as ChatProviderStatus['anthropic'],
    ),
    readCodexStatus(projectRoot, { withModels: true }).catch(
      () =>
        ({
          installed: false,
          version: null,
          loggedIn: false,
          authMode: null,
          email: null,
          planType: null,
          hasKey: false,
        }) as CodexStatus,
    ),
  ]);
  return {
    anthropic,
    openai: { ...openai, models: openAiModels(openai) },
    active: activeProvider(anthropic, openai, (await readAppSettings(projectRoot)).provider),
  };
}

/**
 * Which provider answers. An explicit preference wins WHEN THAT PROVIDER IS
 * USABLE — a stored preference for a provider you've since signed out of
 * should quietly fall through, not break the conversation. Mirrors the
 * fall-through order in createChatDriver so the label never lies about who is
 * about to answer.
 */
export function activeProvider(
  anthropic: ChatProviderStatus['anthropic'],
  openai: CodexStatus,
  preferred: ChatProvider | undefined,
): ChatProvider | null {
  const usable: ChatProvider[] = [];
  // Either route in counts, but the CLI only counts when it is SIGNED IN.
  // `cli` alone means the binary exists, which is not an answer to whether a
  // turn would be answered. See the note on the status shape.
  if (anthropic.hasKey || anthropic.loggedIn) usable.push('anthropic');
  if (openai.installed && openai.loggedIn) usable.push('openai');
  if (usable.length === 0) return null;
  if (preferred && usable.includes(preferred)) return preferred;
  return usable[0];
}

/** Re-read and announce this folder's provider status. */
export async function announceProviders(projectRoot: string): Promise<ChatProviderStatus> {
  // An announce means something about who can answer just CHANGED, which is
  // exactly when a cached sign-in is most likely to be the stale one. Pay for
  // the spawn here rather than telling every open window something that was
  // true ten seconds ago. Reads that are merely routine keep the cache.
  forgetClaudeAuth();
  // And the catalogue with it: which models are offered belongs to the ACCOUNT,
  // so a sign-in that just landed can be a different list, not just a different
  // email. Its own cache is measured in minutes and would otherwise outlast the
  // account it was read for.
  forgetClaudeModels();
  const status = await readChatProviders(projectRoot);
  providerBus.emit('changed', { root: projectRoot, status });
  return status;
}

/**
 * Kick off the ChatGPT sign-in. The browser half happens outside the app
 * entirely (codex runs its own localhost callback), so the reply is just the
 * URL to open; completion arrives later and is announced on the bus, which is
 * what makes Settings update itself rather than asking the user to confirm.
 */
export async function beginOpenAiLogin(projectRoot: string): Promise<{ ok: boolean; authUrl?: string; error?: string }> {
  const { authUrl, error } = await startCodexLogin(projectRoot, () => {
    void announceProviders(projectRoot);
  });
  if (error) return { ok: false, error };
  if (!authUrl) return { ok: false, error: 'codex did not return a sign-in URL.' };
  return { ok: true, authUrl };
}
