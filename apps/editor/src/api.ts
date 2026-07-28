/**
 * Thin client over the app server's HTTP surface (server/projectServer.ts).
 * Everything streaming — conversation, evidence, terminal — rides the
 * WebSocket instead; see store.ts.
 */
import type {
  AgentCliInfo,
  AppSettingsInfo,
  ChatProvider,
  ChatProviderStatus,
  ChatSummary,
  ContextFile,
  ModelPrefsInfo,
  RecentChatEntry,
  GameStatus,
  ProbeStatus,
  ProjectFile,
  RecentWorkspace,
  Sense,
  ServerMeta,
  WorkspaceInfo,
} from './types';
import type { TesterNote } from '../server/tester/types';

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
 * Make a folder for a game that doesn't have one yet: the server derives a
 * slug, creates it under the projects home (~/Hearth), and opens it exactly as
 * /api/workspace/open would.
 *
 * Two ways in, because there are two moments this happens. From Home the first
 * message IS the project, so the folder is named after the `prompt`. From the
 * rail there is no message yet, so a `name` is asked for and the server prefers
 * it over the prompt. Both arguments are optional and either alone is enough —
 * the prompt stays first so the Home call site reads as it always did.
 */
export async function apiCreateWorkspace(
  prompt?: string,
  name?: string,
): Promise<{ ok: boolean; info?: WorkspaceInfo; error?: string }> {
  const res = await postJson<OpenResult>('/api/workspace/create', { prompt, name });
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

/**
 * Give a project a mark and a colour. An empty string clears a field back to
 * the one derived from its path, which is what the picker's Reset sends.
 */
export async function apiSetProjectIdentity(
  project: string,
  patch: { icon?: string; color?: string },
): Promise<boolean> {
  const res = await postJson<{ ok: boolean }>('/api/workspace/identity', { project, ...patch });
  return res?.ok === true;
}

// ---------------------------------------------------------------------------
// A project's own material: the instructions every conversation in it starts
// with, and the files the agent should have read. Both live in the project
// folder rather than in the app, so they survive it.
// ---------------------------------------------------------------------------

/** Read one text document from the project root (e.g. AGENTS.md). */
export async function apiProjectDoc(project: string, name: string): Promise<string | null> {
  const body = await getJson<{ text: string }>(
    `/api/project/doc?project=${encodeURIComponent(project)}&name=${encodeURIComponent(name)}`,
    'apiProjectDoc',
  );
  return body?.text ?? null;
}

export async function apiWriteProjectDoc(project: string, name: string, text: string): Promise<boolean> {
  const res = await postJson<{ ok: boolean }>('/api/project/doc', { project, name, text });
  return res?.ok === true;
}

export async function apiContextFiles(project: string): Promise<ContextFile[]> {
  const body = await getJson<{ files: ContextFile[] }>(
    `/api/context?project=${encodeURIComponent(project)}`,
    'apiContextFiles',
  );
  return body?.files ?? [];
}

export async function apiSaveContextFiles(
  project: string,
  files: readonly { name: string; data: string }[],
): Promise<ContextFile[]> {
  const res = await postJson<{ files: ContextFile[] }>('/api/context', { project, files });
  return res?.files ?? [];
}

export async function apiDeleteContextFile(project: string, name: string): Promise<ContextFile[]> {
  const res = await postJson<{ files: ContextFile[] }>('/api/context/delete', { project, name });
  return res?.files ?? [];
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
    shimDetected: body.shimDetected === true,
  };
}

// ---------------------------------------------------------------------------
// The private tester
// ---------------------------------------------------------------------------

/** What the history route hands back: every session, oldest first, plus memory. */
export interface TesterHistory {
  sessions: TesterNote[];
  /** The tester's durable notes about this game, as markdown. */
  memory: string;
  running: boolean;
  /** Turns a session is allowed, so the budget can be shown before it is spent. */
  maxSteps: number;
}

/**
 * Ask the tester to play. Answers immediately: the session itself runs on the
 * server for minutes afterwards and reports over the socket.
 */
export async function apiTesterPlay(
  project: string,
  maxSteps?: number,
): Promise<{ ok: boolean; session?: number; maxSteps?: number; error?: string }> {
  return postJson('/api/tester/play', { project, maxSteps });
}

export async function apiTesterStop(project: string): Promise<{ ok: boolean; error?: string }> {
  return postJson('/api/tester/stop', { project });
}

export async function apiTesterHistory(project: string): Promise<TesterHistory | null> {
  const body = await getJson<TesterHistory>(
    `/api/tester/history?project=${encodeURIComponent(project)}`,
    'apiTesterHistory',
  );
  if (!body) return null;
  return {
    sessions: Array.isArray(body.sessions) ? body.sessions : [],
    memory: typeof body.memory === 'string' ? body.memory : '',
    running: body.running === true,
    maxSteps: typeof body.maxSteps === 'number' ? body.maxSteps : 0,
  };
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

// ---------------------------------------------------------------------------
// Personalization: what to call you, and the instructions that apply to every
// game rather than to one. Kept in `~/.hearth`, so unlike almost everything
// else here these routes take no project.
// ---------------------------------------------------------------------------

export interface Personalization {
  /** What the agent should call you. Empty means no preference. */
  name: string;
  /** Standing instructions for every project. Markdown, as typed. */
  instructions: string;
}

/** Where the server put each of them — shown so someone can go and look. */
export interface PersonalizationFiles {
  name: string;
  instructions: string;
}

export interface PersonalizationInfo {
  personalization: Personalization;
  files: PersonalizationFiles;
}

function readPersonalizationBody(body: Partial<PersonalizationInfo> | null): PersonalizationInfo | null {
  const values = body?.personalization;
  const files = body?.files;
  if (!values || !files) return null;
  return {
    personalization: { name: values.name ?? '', instructions: values.instructions ?? '' },
    files: { name: files.name ?? '', instructions: files.instructions ?? '' },
  };
}

/**
 * Which agent CLIs this machine has (server/agentClis.ts). Null when the read
 * did not land — the picker shows "checking" for that rather than an empty
 * list, because "none installed" and "not asked yet" are different answers and
 * only one of them is the machine's.
 *
 * Takes no project: what is installed is a fact about the machine, and the
 * picker asks on Home too.
 */
export async function apiAgentClis(): Promise<AgentCliInfo[] | null> {
  const body = await getJson<{ clis: AgentCliInfo[] }>('/api/agent-clis', 'apiAgentClis');
  return Array.isArray(body?.clis) ? body.clis : null;
}

export async function apiPersonalization(): Promise<PersonalizationInfo | null> {
  return readPersonalizationBody(await getJson<PersonalizationInfo>('/api/personalization', 'apiPersonalization'));
}

/**
 * Which models the user switched off (server/modelPrefs.ts). Also unscoped:
 * it is a preference about the person, and the composer's picker asks for it
 * on Home where there is no folder.
 *
 * Null on a failed read, which the caller treats as "nothing is switched off"
 * rather than as an empty catalogue.
 */
export async function apiModelPrefs(): Promise<ModelPrefsInfo | null> {
  const body = await getJson<ModelPrefsInfo>('/api/model-prefs', 'apiModelPrefs');
  if (!body) return null;
  return {
    disabled: Array.isArray(body.disabled) ? body.disabled.filter((id): id is string => typeof id === 'string') : [],
    file: typeof body.file === 'string' ? body.file : '',
  };
}

/**
 * Switch one model on or off. One model per call, never the whole list: the
 * server holds entries for models this client cannot see, and sending a list
 * built from what it can see would quietly delete them.
 */
export async function apiSetModelEnabled(model: string, enabled: boolean): Promise<ModelPrefsInfo | null> {
  try {
    const body = await postJson<Partial<ModelPrefsInfo> & { ok: boolean }>('/api/model-prefs', { model, enabled });
    if (!body.ok || !Array.isArray(body.disabled)) return null;
    return {
      disabled: body.disabled.filter((id): id is string => typeof id === 'string'),
      file: typeof body.file === 'string' ? body.file : '',
    };
  } catch (err) {
    console.error('apiSetModelEnabled: request failed', err);
    return null;
  }
}

/**
 * Change one or both. Omitting a field leaves it alone; sending an empty
 * string clears it, which is a real instruction and not the same as omitting.
 */
export async function apiSavePersonalization(patch: Partial<Personalization>): Promise<PersonalizationInfo | null> {
  const body = await postJson<Partial<PersonalizationInfo> & { ok: boolean }>('/api/personalization', patch);
  return body.ok ? readPersonalizationBody(body) : null;
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

// ---------------------------------------------------------------------------
// Usage
//
// Counts of what is on this machine's disk — folders opened, conversations
// held, playtests run. Like personalization and skills, it is about the person
// rather than one open folder, so the route takes no project.
// ---------------------------------------------------------------------------

import type { UsageReport } from '../server/usage';

export type { UsageProject, UsageReport, UsageSkills } from '../server/usage';

/** Read the counts. Null when the server could not be reached. */
export async function apiUsage(): Promise<UsageReport | null> {
  const body = await getJson<{ usage: UsageReport }>('/api/usage', 'apiUsage');
  return body?.usage ?? null;
}
