/**
 * Thin client over the app server's HTTP surface (server/projectServer.ts).
 * Everything streaming — conversation, evidence, terminal — rides the
 * WebSocket instead; see store.ts.
 */
import type {
  AppSettingsInfo,
  GameStatus,
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

export async function apiProbeStatus(project: string): Promise<Sense[]> {
  const body = await getJson<{ senses: Sense[] }>(`/api/probe/status?project=${encodeURIComponent(project)}`, 'apiProbeStatus');
  return body?.senses ?? [];
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

export async function apiSaveApiKey(project: string, apiKey: string): Promise<AppSettingsInfo | null> {
  const body = await postJson<AppSettingsInfo & { ok: boolean }>('/api/app/settings', { project, apiKey });
  return body.ok ? { hasKey: body.hasKey, source: body.source } : null;
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

/** URL for a file inside `.hearth/evidence/` (screenshots, reports). */
export function evidenceUrl(project: string, relPath: string): string {
  return `/evidence/${rootKey(project)}/${relPath.replace(/^\.hearth\/evidence\//, '')}`;
}
