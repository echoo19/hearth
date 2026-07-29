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
  PermissionMode,
  PermissionModeInfo,
  RecentChatEntry,
  GameStatus,
  ProbeStatus,
  ProjectFile,
  RecentWorkspace,
  TesterRunHistory,
  Sense,
  ServerMeta,
  WorkspaceInfo,
} from './types';
import type { TesterNote } from '../server/tester/types';

/**
 * What a POST that never got an answer comes back as. Deliberately the same
 * shape a server refusal takes, so a dead server and a server that said no
 * arrive through the one door and every caller narrows on `ok` alone.
 */
interface PostFailure {
  ok: false;
  error: string;
}

/**
 * The words for a request that never landed. Plain, and honest about what is
 * known — the request failed, not why — because these are shown to the person
 * who clicked, inline in dialogs and toasts.
 */
const POST_FAILED = 'Could not reach the Hearth server. Try again in a moment.';

/**
 * POST a JSON body and read the JSON reply.
 *
 * This used to be a bare fetch + res.json(), which split failure in two: a
 * clean `ok: false` came back as a value, while a transport failure — server
 * gone, connection refused, an error page where JSON should be — came back as
 * a THROW. Callers handled the value and forgot the throw, so a create left
 * its dialog on "Creating…" forever and a rename just silently didn't happen.
 * Now failure IS the value: this never rejects, and the one case a caller has
 * to handle is `ok: false` with the reason in words a person can be shown.
 * `label` names the caller in the console record, exactly as getJson's does.
 */
async function postJson<T>(url: string, body: unknown, label: string): Promise<T | PostFailure> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as T & { ok?: unknown };
    // A refusal status whose body carries the server's own envelope is the
    // server saying no, and its words win. JSON on a refusal status that does
    // NOT say `ok: false` came from something that is not our server — a
    // proxy's error body, say — and adopting it as an answer would be a lie.
    if (!res.ok && parsed?.ok !== false) {
      console.error(`${label}: server answered ${res.status}`);
      return { ok: false, error: `The server answered ${res.status} instead of a result.` };
    }
    return parsed;
  } catch (err) {
    // Same floor as getJson: the console keeps the raw cause, the caller gets
    // the sentence.
    console.error(`${label}: request failed`, err);
    return { ok: false, error: POST_FAILED };
  }
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
  const res = await postJson<OpenResult>('/api/workspace/open', { path }, 'apiOpenWorkspace');
  if (!res.ok || !res.path) return { ok: false, error: res.error ?? 'Could not open that folder.' };
  return {
    ok: true,
    info: { path: res.path, name: res.name ?? res.path, isHearthProject: res.isHearthProject === true },
  };
}

/**
 * Tell the server a folder is done: it drops out of the set of roots the
 * server will serve files from, accept sockets for, or run anything in.
 *
 * Closing used to be client-state only, so a folder opened once stayed
 * reachable for the life of the process and the jail only ever grew. Nothing
 * here can fail in a way the person closing a project needs to hear about, so
 * it answers void and the caller does not wait for it.
 *
 * Which is exactly why it must never reject — and, since postJson answers
 * failure as a value now, it can't. Called and not awaited, a rejection would
 * be an unhandled one, and the moment it is most likely to fail — the server
 * already gone, on the way out of the app — is the moment nobody is left to
 * care. A server that is not there is not serving the folder either.
 */
export async function apiCloseWorkspace(path: string): Promise<void> {
  await postJson<{ ok?: boolean }>('/api/workspace/close', { path }, 'apiCloseWorkspace');
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
  const res = await postJson<OpenResult>('/api/workspace/create', { prompt, name }, 'apiCreateWorkspace');
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
  const res = await postJson<{ ok: boolean }>('/api/workspace/identity', { project, ...patch }, 'apiSetProjectIdentity');
  return res.ok === true;
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
  const res = await postJson<{ ok: boolean }>('/api/project/doc', { project, name, text }, 'apiWriteProjectDoc');
  return res.ok === true;
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
  const res = await postJson<{ files: ContextFile[] }>('/api/context', { project, files }, 'apiSaveContextFiles');
  // A failed write answers the empty list, which is what this wrapper has
  // always answered for a refusal; the reason is on the console via postJson.
  return 'files' in res && Array.isArray(res.files) ? res.files : [];
}

export async function apiDeleteContextFile(project: string, name: string): Promise<ContextFile[]> {
  const res = await postJson<{ files: ContextFile[] }>('/api/context/delete', { project, name }, 'apiDeleteContextFile');
  return 'files' in res && Array.isArray(res.files) ? res.files : [];
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
  return postJson('/api/tester/play', { project, maxSteps }, 'apiTesterPlay');
}

export async function apiTesterStop(project: string): Promise<{ ok: boolean; error?: string }> {
  return postJson('/api/tester/stop', { project }, 'apiTesterStop');
}

/** One picture behind an approved proposal, as the project stores it. */
export interface ApprovedFrame {
  frame: number;
  /** Project-relative, posix, so it works as a link and as a path an agent reads. */
  relPath: string;
}

/**
 * Turn the proposals someone ticked into the message that starts work on them.
 *
 * The server writes it from the note on disk. The window sends ids and gets
 * back words, so nothing that was left unticked can reach an agent through a
 * message the window assembled for itself.
 */
export async function apiTesterApprove(
  project: string,
  session: number,
  proposals: readonly string[],
): Promise<{ ok: boolean; text?: string; frames?: ApprovedFrame[]; error?: string }> {
  return postJson('/api/tester/approve', { project, session, proposals }, 'apiTesterApprove');
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

/**
 * Every recent playtest across every game. Takes no project: a playtest belongs
 * to a game, but the history of playtests belongs to the person, so this reads
 * the server's own recents list the way skills and usage do.
 */
export async function apiTesterHistoryAll(): Promise<TesterRunHistory | null> {
  const body = await getJson<TesterRunHistory>('/api/tester/history/all', 'apiTesterHistoryAll');
  if (!body) return null;
  const runs = Array.isArray(body.runs) ? body.runs : [];
  const kept = runs.filter((run) => run?.note && run?.project?.path);
  return {
    runs: kept,
    dropped: typeof body.dropped === 'number' && body.dropped > 0 ? body.dropped : 0,
    // The server's own count, plus anything this filter just threw away. A run
    // dropped here is still a run the screen is not showing.
    skippedProjects:
      (typeof body.skippedProjects === 'number' && body.skippedProjects > 0 ? body.skippedProjects : 0) +
      (runs.length - kept.length > 0 ? 1 : 0),
  };
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export async function apiListChats(project: string): Promise<ChatSummary[]> {
  const body = await getJson<{ chats: ChatSummary[] }>(`/api/chats?project=${encodeURIComponent(project)}`, 'apiListChats');
  return body?.chats ?? [];
}

/**
 * Rename and delete answer either the refreshed list or the reason, never
 * null. They used to answer null for both "the server said no" and "the
 * request never arrived", and null was silence: the rail showed the old title
 * back, or the row it was told to delete, with no word about why. The reason
 * comes out so the store can put it in front of the person who clicked.
 */
export async function apiRenameChat(
  project: string,
  chatId: string,
  title: string,
): Promise<{ ok: true; chats: ChatSummary[] } | { ok: false; error: string }> {
  const body = await postJson<{ ok: boolean; chats?: ChatSummary[]; error?: string }>(
    '/api/chats/rename',
    { project, chatId, title },
    'apiRenameChat',
  );
  if (!body.ok) return { ok: false, error: body.error ?? 'Could not rename that conversation.' };
  return { ok: true, chats: body.chats ?? [] };
}

export async function apiDeleteChat(
  project: string,
  chatId: string,
): Promise<{ ok: true; chats: ChatSummary[] } | { ok: false; error: string }> {
  const body = await postJson<{ ok: boolean; chats?: ChatSummary[]; error?: string }>(
    '/api/chats/delete',
    { project, chatId },
    'apiDeleteChat',
  );
  if (!body.ok) return { ok: false, error: body.error ?? 'Could not delete that conversation.' };
  return { ok: true, chats: body.chats ?? [] };
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
  const body = await postJson<AppSettingsInfo & { ok: boolean }>(
    '/api/app/settings',
    { project, ...patch },
    'apiSaveProviderSettings',
  );
  return body.ok ? { hasKey: body.hasKey, source: body.source } : null;
}

// ---------------------------------------------------------------------------
// How much the agent asks before it acts. Per project, because the answer is
// about the folder you are working in and not about the person: one game you
// are watching closely and one you are letting run are a normal pair.
// ---------------------------------------------------------------------------

/** Every mode the window knows how to honour, in menu order. */
const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'auto', 'skip'];

/**
 * Read a body into an answer, or into nothing.
 *
 * The mode is checked against the list above rather than cast, because an
 * unrecognised string is the one failure that must not be adopted: a mode the
 * window cannot name is a mode it cannot show, and a permission setting the
 * user cannot see is not one they can have meant. Null sends the caller back
 * to its own default.
 */
function readPermissionMode(body: Partial<PermissionModeInfo> | null): PermissionModeInfo | null {
  const mode = PERMISSION_MODES.find((known) => known === body?.mode);
  if (!mode) return null;
  return { mode, skipAcknowledged: body?.skipAcknowledged === true };
}

/**
 * What this project asks for. Null when the read did not land, which the
 * caller shows as the default rather than as an empty control.
 */
export async function apiPermissionMode(project: string): Promise<PermissionModeInfo | null> {
  return readPermissionMode(
    await getJson<PermissionModeInfo>(
      `/api/permission-mode?project=${encodeURIComponent(project)}`,
      'apiPermissionMode',
    ),
  );
}

/**
 * Change the mode, the acknowledgement, or both in one write. Both optional:
 * confirming what `skip` means is a single act, and sending it as two calls
 * would leave a project that could be asked twice if the second one failed.
 */
export async function apiSetPermissionMode(
  project: string,
  patch: Partial<PermissionModeInfo>,
): Promise<PermissionModeInfo | null> {
  const body = await postJson<Partial<PermissionModeInfo> & { ok: boolean }>(
    '/api/permission-mode',
    { project, ...patch },
    'apiSetPermissionMode',
  );
  return body.ok ? readPermissionMode(body) : null;
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
  const body = await postJson<Partial<ModelPrefsInfo> & { ok: boolean }>(
    '/api/model-prefs',
    { model, enabled },
    'apiSetModelEnabled',
  );
  if (!body.ok || !Array.isArray(body.disabled)) return null;
  return {
    disabled: body.disabled.filter((id): id is string => typeof id === 'string'),
    file: typeof body.file === 'string' ? body.file : '',
  };
}

/**
 * Change one or both. Omitting a field leaves it alone; sending an empty
 * string clears it, which is a real instruction and not the same as omitting.
 */
export async function apiSavePersonalization(patch: Partial<Personalization>): Promise<PersonalizationInfo | null> {
  const body = await postJson<Partial<PersonalizationInfo> & { ok: boolean }>(
    '/api/personalization',
    patch,
    'apiSavePersonalization',
  );
  return body.ok ? readPersonalizationBody(body) : null;
}

/**
 * What could answer a turn in this folder. Read defensively — the two halves
 * are gathered from very different places (a file on disk, and shelling out to
 * `codex`), so a partial or older answer must degrade to "not configured"
 * rather than take the dialog down.
 */
export async function apiChatProviders(project: string | null): Promise<ChatProviderStatus | null> {
  try {
    // No project means the Home screen is asking: who is signed in is a fact
    // about the machine, and the server answers it without a folder.
    const res = await fetch(
      project === null
        ? '/api/chat/providers'
        : `/api/chat/providers?project=${encodeURIComponent(project)}`,
    );
    const body = (await res.json()) as Partial<ChatProviderStatus> & { ok?: boolean };
    if (body.ok === false || !body.anthropic || !body.openai) return null;
    const { anthropic, openai } = body;
    return {
      anthropic: {
        hasKey: anthropic.hasKey === true,
        source: anthropic.source ?? null,
        // Absent on an older server, which is the same as "no CLI seen".
        cli: anthropic.cli === true,
        // Also absent on an older server, and read as signed out. That is the
        // safe direction: it offers a sign-in to someone who has one rather
        // than claiming a sign-in for someone who does not.
        loggedIn: anthropic.loggedIn === true,
        email: typeof anthropic.email === 'string' ? anthropic.email : null,
        planType: typeof anthropic.planType === 'string' ? anthropic.planType : null,
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
  return postJson<{ ok: boolean; authUrl?: string; error?: string }>(
    '/api/chat/providers/openai/login',
    { project },
    'apiOpenAiLogin',
  );
}

// ---------------------------------------------------------------------------
// Static mounts
//
// These are the only URLs in the app that are ABSOLUTE, and they have to be.
// The game and evidence mounts are served from a second loopback origin (see
// server/gameServer.ts) so that a game's own JavaScript is cross-origin to
// this API and cannot reach the WebSocket channel that spawns shells. A
// relative `/game/...` would put the agent's HTML back on the editor's origin,
// which is the whole bug. `origin` comes from GET /api/meta, because the port
// is picked at startup and there is nothing to hardcode.
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

/**
 * URL the game pane iframes. `cacheBust` forces a real reload after an edit.
 *
 * `origin` is required, and callers must have one before they can build a URL
 * at all. There is deliberately no relative fallback: a caller that does not
 * know the game origin yet has to show nothing rather than reach for this one.
 */
export function gameUrl(origin: string, project: string, entry: string, cacheBust?: number): string {
  const suffix = cacheBust ? `?t=${cacheBust}` : '';
  return `${origin}/game/${rootKey(project)}/${entry}${suffix}`;
}

/**
 * URL for any file inside the project, by its project-relative path. Used for
 * chat attachments, which live in the conversation's own folder — the bytes
 * are the project's, so they are read the way every other project file is.
 */
export function projectFileUrl(project: string, relPath: string): string {
  return `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(relPath)}`;
}

/**
 * URL for a file inside `.hearth/evidence/` (screenshots, reports). Served
 * from the game origin for the same reason the game is: these are the
 * project's own bytes, and project bytes never come off the editor's origin.
 */
export function evidenceUrl(origin: string, project: string, relPath: string): string {
  return `${origin}/evidence/${rootKey(project)}/${relPath.replace(/^\.hearth\/evidence\//, '')}`;
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
