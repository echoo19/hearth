/**
 * Thin client over the app server's HTTP surface (server/projectServer.ts).
 * Everything streaming — conversation, evidence, terminal — rides the
 * WebSocket instead; see store.ts.
 */
import type {
  AppSettingsInfo,
  ChatProvider,
  ChatProviderStatus,
  ChatSummary,
  RecentChatEntry,
  GameStatus,
  ProbeStatus,
  ProjectFile,
  RecentWorkspace,
  Sense,
  ServerMeta,
  WorkspaceInfo,
} from './types';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

/** GET a JSON body, returning null on transport failure or `ok: false`. */
async function getJson<T>(url: string, label: string): Promise<(T & { ok: boolean }) | null> {
  try {
    const res = await fetch(url);
    const body = (await res.json()) as T & { ok?: boolean };
    return body.ok ? (body as T & { ok: boolean }) : null;
  } catch (err) {
    // These run before any project (and therefore the store's log()) exists,
    // so console.error is the floor for visibility.
    console.error(`${label}: request failed`, err);
    return null;
  }
}

export interface OpenResult {
  ok: boolean;
  path?: string;
  name?: string;
  isHearthProject?: boolean;
  error?: string;
}

/** Open any folder as the working folder — no hearth.json required. */
export async function apiOpenWorkspace(path: string): Promise<{ ok: boolean; info?: WorkspaceInfo; error?: string }> {
  const res = await postJson<OpenResult>('/api/workspace/open', { path });
  if (!res.ok || !res.path) return { ok: false, error: res.error ?? 'Could not open that folder.' };
  return {
    ok: true,
    info: { path: res.path, name: res.name ?? res.path, isHearthProject: res.isHearthProject === true },
  };
}

/**
 * Make a folder for a game nobody has named yet: the server derives a slug
 * from the prompt, creates it under the projects home (~/Hearth), and opens
 * it exactly as /api/workspace/open would.
 */
export async function apiCreateWorkspace(prompt?: string): Promise<{ ok: boolean; info?: WorkspaceInfo; error?: string }> {
  const res = await postJson<OpenResult>('/api/workspace/create', { prompt });
  if (!res.ok || !res.path) return { ok: false, error: res.error ?? 'Could not create a folder.' };
  return {
    ok: true,
    info: { path: res.path, name: res.name ?? res.path, isHearthProject: res.isHearthProject === true },
  };
}

/** Every conversation across recent folders, newest first — the Recents list. */
export async function apiRecentChats(): Promise<RecentChatEntry[]> {
  const body = await getJson<{ chats: RecentChatEntry[] }>('/api/chats/recent', 'apiRecentChats');
  return body?.chats ?? [];
}

export async function apiRecentWorkspaces(): Promise<RecentWorkspace[]> {
  const body = await getJson<{ projects: RecentWorkspace[] }>('/api/workspace/recent', 'apiRecentWorkspaces');
  return body?.projects ?? [];
}

export function apiMeta(): Promise<ServerMeta | null> {
  return getJson<ServerMeta>('/api/meta', 'apiMeta') as Promise<ServerMeta | null>;
}

export async function apiGameStatus(project: string): Promise<GameStatus | null> {
  const body = await getJson<GameStatus>(`/api/game/status?project=${encodeURIComponent(project)}`, 'apiGameStatus');
  return body ? { present: body.present, entry: body.entry, mtime: body.mtime } : null;
}

export async function apiProbeStatus(project: string): Promise<ProbeStatus | null> {
  const body = await getJson<ProbeStatus>(`/api/probe/status?project=${encodeURIComponent(project)}`, 'apiProbeStatus');
  if (!body) return null;
  return {
    senses: Array.isArray(body.senses) ? body.senses : [],
    playing: body.playing === true,
    shimDetected: body.shimDetected === true,
  };
}

/** What POST /api/probe/sweep answers: started, or why not (409 = one already is). */
export interface SweepStartResult {
  ok: boolean;
  /** Number of runs the sweep will do, so progress has a denominator. */
  total?: number;
  error?: string;
  busy?: boolean;
}

/**
 * Ask the probe to play the game. Returns as soon as the sweep STARTS —
 * everything it finds arrives on the evidence channel, so there is nothing to
 * wait for here.
 */
export async function apiStartSweep(
  project: string,
  request: { policies?: string[]; seeds?: number[]; maxSteps?: number } = {},
): Promise<SweepStartResult> {
  try {
    const res = await fetch('/api/probe/sweep', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, ...request }),
    });
    const body = (await res.json()) as {
      ok?: boolean;
      error?: string;
      policies?: string[];
      seeds?: number[];
    };
    if (!body.ok) {
      return { ok: false, busy: res.status === 409, error: body.error ?? 'The playtest could not start.' };
    }
    const total = (body.policies?.length ?? 0) * (body.seeds?.length ?? 0);
    return { ok: true, total: total > 0 ? total : undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function apiListChats(project: string): Promise<ChatSummary[]> {
  const body = await getJson<{ chats: ChatSummary[] }>(`/api/chats?project=${encodeURIComponent(project)}`, 'apiListChats');
  return body?.chats ?? [];
}

export async function apiRenameChat(project: string, chatId: string, title: string): Promise<ChatSummary[] | null> {
  const body = await postJson<{ ok: boolean; chats?: ChatSummary[] }>('/api/chats/rename', { project, chatId, title });
  return body.ok ? (body.chats ?? []) : null;
}

export async function apiDeleteChat(project: string, chatId: string): Promise<ChatSummary[] | null> {
  const body = await postJson<{ ok: boolean; chats?: ChatSummary[] }>('/api/chats/delete', { project, chatId });
  return body.ok ? (body.chats ?? []) : null;
}

export async function apiListFiles(project: string): Promise<ProjectFile[]> {
  const body = await getJson<{ files: ProjectFile[] }>(`/api/files?project=${encodeURIComponent(project)}`, 'apiListFiles');
  return body?.files ?? [];
}

/** Read one file's text. Returns null when it can't be read (binary, missing). */
export async function apiReadFile(project: string, relPath: string): Promise<string | null> {
  const url = `/api/fs?project=${encodeURIComponent(project)}&op=read&path=${encodeURIComponent(relPath)}`;
  const body = await getJson<{ content: string }>(url, 'apiReadFile');
  return typeof body?.content === 'string' ? body.content : null;
}

export async function apiAppSettings(project: string): Promise<AppSettingsInfo | null> {
  const body = await getJson<AppSettingsInfo>(`/api/app/settings?project=${encodeURIComponent(project)}`, 'apiAppSettings');
  return body ? { hasKey: body.hasKey, source: body.source } : null;
}

/**
 * Everything the settings dialog can change about who answers a turn. All
 * optional and independently applied: saving a Codex path must not clear the
 * Anthropic key, so a patch says only what it means to change.
 */
export interface ProviderSettingsPatch {
  /** Anthropic key. Empty string removes the stored one. */
  apiKey?: string;
  /** OpenAI key. Empty string removes the stored one. */
  openaiApiKey?: string;
  /** Which provider answers when both could. */
  provider?: ChatProvider;
  /** Where the `codex` binary is, when it isn't on PATH. */
  codexPath?: string;
}

export async function apiSaveProviderSettings(
  project: string,
  patch: ProviderSettingsPatch,
): Promise<AppSettingsInfo | null> {
  const body = await postJson<AppSettingsInfo & { ok: boolean }>('/api/app/settings', { project, ...patch });
  return body.ok ? { hasKey: body.hasKey, source: body.source } : null;
}

/**
 * What could answer a turn in this folder. Read defensively — the two halves
 * are gathered from very different places (a file on disk, and shelling out to
 * `codex`), so a partial or older answer must degrade to "not configured"
 * rather than take the dialog down.
 */
export async function apiChatProviders(project: string): Promise<ChatProviderStatus | null> {
  try {
    const res = await fetch(`/api/chat/providers?project=${encodeURIComponent(project)}`);
    const body = (await res.json()) as Partial<ChatProviderStatus> & { ok?: boolean };
    if (body.ok === false || !body.anthropic || !body.openai) return null;
    const { anthropic, openai } = body;
    return {
      anthropic: {
        hasKey: anthropic.hasKey === true,
        source: anthropic.source ?? null,
        models: Array.isArray(anthropic.models) ? anthropic.models : undefined,
      },
      openai: {
        installed: openai.installed === true,
        version: openai.version ?? null,
        loggedIn: openai.loggedIn === true,
        authMode: openai.authMode ?? null,
        email: openai.email ?? null,
        planType: openai.planType ?? null,
        hasKey: openai.hasKey === true,
        models: Array.isArray(openai.models) ? openai.models : undefined,
      },
      active: body.active ?? null,
    };
  } catch (err) {
    console.error('apiChatProviders: request failed', err);
    return null;
  }
}

/**
 * Start the ChatGPT sign-in. Answers with the URL to open — the flow itself
 * happens in a browser, and its completion arrives as a `chat-providers`
 * frame on the socket rather than as this call's return value.
 */
export function apiOpenAiLogin(project: string): Promise<{ ok: boolean; authUrl?: string; error?: string }> {
  return postJson<{ ok: boolean; authUrl?: string; error?: string }>('/api/chat/providers/openai/login', { project });
}

// ---------------------------------------------------------------------------
// Static mounts
// ---------------------------------------------------------------------------

/**
 * base64url of the folder path — the same key the server decodes. Kept in
 * lockstep with `encodeRootKey` in server/projectServer.ts.
 */
export function rootKey(project: string): string {
  const bytes = new TextEncoder().encode(project);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** URL the game pane iframes. `cacheBust` forces a real reload after an edit. */
export function gameUrl(project: string, entry: string, cacheBust?: number): string {
  const suffix = cacheBust ? `?t=${cacheBust}` : '';
  return `/game/${rootKey(project)}/${entry}${suffix}`;
}

/**
 * URL for any file inside the project, by its project-relative path. Used for
 * chat attachments, which live in the conversation's own folder — the bytes
 * are the project's, so they are read the way every other project file is.
 */
export function projectFileUrl(project: string, relPath: string): string {
  return `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(relPath)}`;
}

/** URL for a file inside `.hearth/evidence/` (screenshots, reports). */
export function evidenceUrl(project: string, relPath: string): string {
  return `/evidence/${rootKey(project)}/${relPath.replace(/^\.hearth\/evidence\//, '')}`;
}
