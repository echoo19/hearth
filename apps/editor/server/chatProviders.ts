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
import { readAppSettings, resolveApiKey, type ChatProvider } from './chat.js';
import { CODEX_INSTALL_HINT, readCodexStatus, startCodexLogin, type CodexStatus } from './chatDrivers/codex.js';

export { CODEX_INSTALL_HINT };

/** GET /api/chat/providers — the whole picture, in one read. */
export interface ChatProviderStatus {
  anthropic: { hasKey: boolean; source: 'project' | 'environment' | null };
  openai: CodexStatus;
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
async function anthropicStatus(projectRoot: string): Promise<ChatProviderStatus['anthropic']> {
  const stored = (await readAppSettings(projectRoot)).apiKey?.trim();
  if (stored) return { hasKey: true, source: 'project' };
  const key = await resolveApiKey(projectRoot);
  return key ? { hasKey: true, source: 'environment' } : { hasKey: false, source: null };
}

/**
 * Read both providers. Never throws — a codex binary that hangs or a protocol
 * change degrades to "installed, signed out" rather than a failed request.
 */
export async function readChatProviders(projectRoot: string): Promise<ChatProviderStatus> {
  const [anthropic, openai] = await Promise.all([
    anthropicStatus(projectRoot).catch(() => ({ hasKey: false, source: null }) as ChatProviderStatus['anthropic']),
    readCodexStatus(projectRoot).catch(
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
  return { anthropic, openai, active: activeProvider(anthropic, openai, (await readAppSettings(projectRoot)).provider) };
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
  if (anthropic.hasKey) usable.push('anthropic');
  if (openai.installed && openai.loggedIn) usable.push('openai');
  if (usable.length === 0) return null;
  if (preferred && usable.includes(preferred)) return preferred;
  return usable[0];
}

/** Re-read and announce this folder's provider status. */
export async function announceProviders(projectRoot: string): Promise<ChatProviderStatus> {
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
