/**
 * Thin client over the project server's /api routes.
 */
import type { CommandResult, ExampleProject, ProjectInfo, RecentProject, ServerMeta } from './types';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}

export interface OpenResult {
  ok: boolean;
  path?: string;
  info?: ProjectInfo;
  error?: string;
}

export function apiOpenProject(path: string): Promise<OpenResult> {
  return postJson<OpenResult>('/api/project/open', { path });
}

export function apiCreateProject(dir: string, name: string, description?: string): Promise<OpenResult> {
  return postJson<OpenResult>('/api/project/create', { dir, name, description });
}

export async function apiRecentProjects(): Promise<RecentProject[]> {
  const res = await fetch('/api/project/recent');
  const body = await res.json();
  return body.ok ? (body.projects as RecentProject[]) : [];
}

export async function apiExampleProjects(): Promise<ExampleProject[]> {
  const res = await fetch('/api/project/examples');
  const body = await res.json();
  return body.ok ? (body.examples as ExampleProject[]) : [];
}

export async function apiMeta(): Promise<ServerMeta | null> {
  try {
    const res = await fetch('/api/meta');
    const body = await res.json();
    return body.ok ? (body as ServerMeta) : null;
  } catch {
    return null;
  }
}

export function apiCommand<T = unknown>(
  project: string,
  name: string,
  params: unknown = {},
): Promise<CommandResult<T>> {
  return postJson<CommandResult<T>>('/api/command', { project, name, params });
}

/** Upload a file (base64 bytes) to be registered as a project asset. */
export function apiImportAsset(
  project: string,
  filename: string,
  dataBase64: string,
): Promise<CommandResult> {
  return postJson<CommandResult>('/api/assets/import', { project, filename, dataBase64 });
}

export interface ExportWebData {
  outDir: string;
  singleFile: boolean;
  files: string[];
  title: string;
  slug: string;
}

/** Run the exportWeb command (static playable web build). */
export function apiExportWeb(
  project: string,
  outDir: string,
  singleFile: boolean,
): Promise<CommandResult<ExportWebData>> {
  return postJson<CommandResult<ExportWebData>>('/api/export/web', { project, outDir, singleFile });
}

/** URL for a raw project file (sprites, scripts, scene JSON...). */
export function fileUrl(project: string, relPath: string): string {
  return `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(relPath)}`;
}
