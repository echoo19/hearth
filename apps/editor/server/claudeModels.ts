/**
 * Which Claude models this machine can actually answer with, and which efforts
 * each of them accepts.
 *
 * WHY THIS EXISTS: Hearth's Anthropic catalogue was three curated rows written
 * by hand, with no effort levels on any of them — so the composer's effort
 * control, which renders only when the ACTIVE MODEL declares efforts, never
 * appeared for Claude. It was not a missing feature on the client; the client
 * has been ready since it stopped checking `provider === 'openai'` (see
 * `effortLabel` in src/chat/modelChoice.ts). The list simply never said Claude
 * had a dial, so an effort the user could not choose was also never sent.
 *
 * The SDK does have the equivalent of codex's `model/list`: a query handle
 * answers `supportedModels()` with the real catalogue for the account the CLI
 * is signed into, effort levels included. Read against the installed SDK, one
 * live answer looks like this:
 *
 *   { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet',
 *     description: 'Sonnet 5 · Efficient for routine tasks',
 *     supportsEffort: true, supportedEffortLevels: ['low','medium','high','xhigh','max'] }
 *
 * and the Haiku row in the same answer carries no `supportsEffort` at all,
 * which is exactly the per-model difference a hardcoded list cannot express.
 *
 * THE HANDLE IS NOT A TURN. `query()` opens the CLI and handshakes with it; a
 * prompt stream that never yields means no turn ever runs, so this costs a
 * process and a control request and nothing else. Measured against the real
 * binary: ~2s cold, which is why the answer is cached.
 *
 * Everything here degrades to an empty array rather than throwing. No SDK
 * installed, an older one without `supportedModels`, a CLI that will not
 * handshake, a payload this version does not recognise — all of them mean the
 * same thing to the caller, which is "use the curated fallback".
 */
import { EventQueue, isClaudeEffort, loadAgentSdk } from './chat.js';
import type { ProviderEffortOption, ProviderModelInfo } from './chatProviders.js';

/**
 * How long `supportedModels()` gets before the catalogue is given up on.
 *
 * Matches the budget codex's `model/list` gets in chatDrivers/codex.ts, and for
 * the same reason: this read sits inside `/api/chat/providers`, which the
 * Settings pane and the composer both wait on. A CLI that is wedged should cost
 * the request some seconds and fall back to the curated list, not hold the pane
 * open forever.
 */
const CATALOGUE_TIMEOUT_MS = 15_000;

/**
 * How long an answer is reused.
 *
 * Much longer than the sign-in cache next door, because the two answers move at
 * completely different speeds. A sign-in changes in a terminal while Hearth is
 * running and the user expects the app to notice; the catalogue changes when
 * Anthropic ships a model or a plan changes tier, which is not something that
 * happens between opening two folders. The read costs a CLI spawn (~2s), and
 * paying that every time a window announces itself would be felt.
 *
 * The events that CAN change it out from under us are explicit rather than
 * waited for: `forgetClaudeModels` is called wherever a sign-in could have
 * moved (see announceProviders).
 */
const CACHE_MS = 10 * 60_000;

/** Narrow one untyped catalogue entry. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * The efforts ONE model row declares.
 *
 * `supportsEffort` is the capability flag and it is the only thing trusted
 * here: a row that does not claim the capability gets no efforts even if it
 * somehow carries a level list, because offering a dial the model rejects is a
 * turn that fails for a reason the user could not have predicted.
 *
 * The words are checked against the five the SDK's `EffortLevel` names rather
 * than passed through the way codex's are. The two backends genuinely differ:
 * codex's `ReasoningEffort` is a bare `string` and a live `model/list` returns
 * a word (`ultra`) that no union in this codebase would have known, while the
 * Agent SDK's is a closed union and `applyFlagSettings` is what the driver has
 * to hand it. Anything outside those five would be dropped on the way out (see
 * AgentSdkDriver), so offering it here would be a menu row that does nothing.
 *
 * No descriptions: the SDK ships none per level, and writing them would be
 * inventing the backend's words.
 *
 * Absent rather than empty when there is nothing to offer — "this model has no
 * effort dial" and "we don't recognise any of the ones it named" both mean the
 * same thing to the picker, which is: don't render the control.
 */
function claudeEfforts(model: Record<string, unknown>): ProviderEffortOption[] | undefined {
  if (model.supportsEffort !== true) return undefined;
  const raw = model.supportedEffortLevels;
  if (!Array.isArray(raw)) return undefined;
  const efforts: ProviderEffortOption[] = [];
  for (const level of raw) {
    if (!isClaudeEffort(level)) continue;
    if (efforts.some((effort) => effort.id === level)) continue;
    efforts.push({ id: level });
  }
  return efforts.length > 0 ? efforts : undefined;
}

/**
 * Read `supportedModels()`'s answer into the selector's vocabulary. Exported
 * and kept pure so every shape the SDK might hand back is pinned by tests
 * without a process in sight.
 *
 * Everything is checked rather than trusted: this crosses a process boundary to
 * a CLI the user installed and can upgrade underneath us, and a row built from
 * a missing `value` would be a menu entry that names no model.
 *
 * `isDefault` and `defaultEffort` are deliberately never set. `ModelInfo` has
 * no field for either — the catalogue says which models exist, not which one
 * the CLI would pick — and marking one would be a guess the picker then shows
 * as fact.
 */
export function mapClaudeModels(raw: unknown): ProviderModelInfo[] {
  if (!Array.isArray(raw)) return [];
  const models: ProviderModelInfo[] = [];
  for (const entry of raw) {
    const model = asRecord(entry);
    if (!model) continue;
    // `value` is the id to SEND back, aliases included (`sonnet`, `opus[1m]`).
    // It stays the id for exactly the reason the old comment here gave: the
    // alias is what the person picked by name, and sending the resolved wire
    // id would pin the conversation to a snapshot of what that alias meant
    // today.
    //
    // `resolvedModel` is carried anyway, for MATCHING rather than sending. A
    // choice stored by an older build says `claude-sonnet-5`, no row has that
    // as its id, and without this the menu ticked nothing and the effort dial
    // never appeared, because the efforts live on the row that was never
    // found. The SDK documents the field for precisely this.
    const id = str(model.value);
    if (!id) continue;
    const row: ProviderModelInfo = { id, label: str(model.displayName) ?? id };
    const resolved = str(model.resolvedModel);
    if (resolved) row.resolvedModel = resolved;
    const description = str(model.description);
    if (description) row.description = description;
    const efforts = claudeEfforts(model);
    if (efforts) row.efforts = efforts;
    models.push(row);
  }
  return models;
}

/** A query handle, as far as reading a catalogue off it is concerned. */
interface SdkCatalogueHandle extends AsyncIterable<unknown> {
  supportedModels?(): Promise<unknown>;
  /** `Query` extends AsyncGenerator, so this is how the CLI is torn down. */
  return?(value?: unknown): Promise<unknown>;
}

let cached: { at: number; value: Promise<ProviderModelInfo[]> } | null = null;

/**
 * Drop the cached catalogue. Call this after anything that could have changed
 * WHICH ACCOUNT is answering, since the models an account is offered are the
 * account's, not the machine's.
 */
export function forgetClaudeModels(): void {
  cached = null;
}

/**
 * The real catalogue, or an empty array when it cannot be had.
 *
 * Cached for CACHE_MS. The PROMISE is cached rather than the value, so several
 * callers arriving together share one spawn instead of racing to start their
 * own — the same discipline as readClaudeAuth, and it matters more here
 * because the thing being shared is a CLI process rather than a short command.
 */
export async function readClaudeModels(): Promise<ProviderModelInfo[]> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_MS) return cached.value;
  const value = spawnClaudeModels();
  cached = { at: now, value };
  // A read that threw is not an answer worth keeping: clear the slot so the
  // next caller retries rather than inheriting a rejection for ten minutes.
  // (`spawnClaudeModels` resolves rather than rejects on every path it knows
  // about; this covers the one it doesn't.)
  value.catch(() => {
    if (cached?.value === value) cached = null;
  });
  return value;
}

async function spawnClaudeModels(): Promise<ProviderModelInfo[]> {
  const sdk = await loadAgentSdk().catch(() => null);
  if (!sdk) return [];
  // The prompt stream that never yields and is never closed. This is what makes
  // the handle a handshake rather than a conversation: the SDK is waiting for a
  // turn that will not arrive, so nothing is ever sent to the model.
  const turns = new EventQueue<unknown>();
  let handle: SdkCatalogueHandle | null = null;
  try {
    handle = sdk.query({ prompt: turns }) as SdkCatalogueHandle;
    if (typeof handle.supportedModels !== 'function') return [];
    // Raced rather than awaited: the control request has no timeout of its own,
    // and a CLI that handshakes and then goes quiet would otherwise hold the
    // providers read for as long as it liked.
    const raw = await Promise.race([
      handle.supportedModels(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('supportedModels timed out')), CATALOGUE_TIMEOUT_MS).unref?.();
      }),
    ]);
    return mapClaudeModels(raw);
  } catch {
    // No SDK that answers this, no CLI, no handshake, or a control request that
    // failed. The caller falls back to its curated list.
    return [];
  } finally {
    // Always tear the CLI down, including on the timeout path — a leaked
    // subprocess per providers read would be the expensive kind of bug.
    turns.close();
    try {
      await handle?.return?.(undefined);
    } catch {
      /* already gone */
    }
  }
}
