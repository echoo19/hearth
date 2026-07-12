/**
 * Thin client over the project server's /api routes.
 */
import type {
  CommandResult,
  DesktopPlatform,
  ExampleProject,
  ExportCapability,
  ProjectInfo,
  RecentProject,
  ServerMeta,
  StartDesktopExportResult,
} from './types';
import type { AgentPermissionMode, DetectAgentsResult } from '../server/agentSetup';

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
  } catch (err) {
    // This runs before a project (and therefore the store's log()) is
    // necessarily wired up, so console.error is the floor for visibility —
    // silently returning null here made a network hiccup indistinguishable
    // from a legitimate "nothing to report" response.
    console.error('apiMeta: request failed', err);
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

export interface ImportFilePayload {
  filename: string;
  dataBase64: string;
}

/** Upload multiple files (base64 bytes) in one atomic importAssets batch — one undo/journal entry for the whole drop. */
export function apiImportAssets(
  project: string,
  files: ImportFilePayload[],
  type?: string,
): Promise<CommandResult> {
  return postJson<CommandResult>('/api/assets/import-batch', { project, files, type });
}

export interface ExportWebData {
  outDir: string;
  singleFile: boolean;
  files: string[];
  title: string;
  slug: string;
  /** Set when `zip` was requested: project-relative path of `<slug>-web.zip`. */
  zip?: string;
}

/**
 * Run the exportWeb command (static playable web build). With `zip`, also
 * writes `<slug>-web.zip` next to the output folder and reports its path in
 * `data.zip`.
 */
export function apiExportWeb(
  project: string,
  outDir: string,
  singleFile: boolean,
  zip = false,
): Promise<CommandResult<ExportWebData>> {
  return postJson<CommandResult<ExportWebData>>('/api/export/web', { project, outDir, singleFile, zip });
}

/**
 * Start a desktop export job. Returns `{ ok, jobId }` immediately; progress
 * arrives over the ws as export-progress/-done/-error frames (see types.ts).
 * A second start while one is running comes back `{ ok: false }` (HTTP 409).
 */
export function apiExportDesktop(
  project: string,
  outDir?: string,
  platforms?: DesktopPlatform[],
): Promise<StartDesktopExportResult> {
  return postJson<StartDesktopExportResult>('/api/export/desktop', { project, outDir, platforms });
}

/** Signing capability + the desktop platform ids the export dialog offers. */
export async function apiExportCapability(): Promise<ExportCapability | null> {
  try {
    const res = await fetch('/api/export/capability');
    const body = await res.json();
    return body.ok ? (body as ExportCapability) : null;
  } catch (err) {
    // Distinct from a successful check; log so a network hiccup isn't silent.
    console.error('apiExportCapability: request failed', err);
    return null;
  }
}

/** URL for a raw project file (sprites, scripts, scene JSON...). */
export function fileUrl(project: string, relPath: string): string {
  return `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(relPath)}`;
}

/** Is `claude` / `codex` on PATH? Backs the Agent panel's launch flow. */
export async function apiDetectAgents(): Promise<DetectAgentsResult | null> {
  try {
    const res = await fetch('/api/agent/detect');
    const body = await res.json();
    return body.ok ? (body as DetectAgentsResult) : null;
  } catch (err) {
    // A `null` here is read by AgentPanel as "couldn't check" (distinct from
    // a successful check that found nothing) — log so a network hiccup
    // isn't completely invisible even though the UI already recovers.
    console.error('apiDetectAgents: request failed', err);
    return null;
  }
}

export interface PrepareAgentResult {
  ok: boolean;
  written?: boolean;
  error?: string;
}

/** Merge-writes the project's .mcp.json with a hearth MCP server entry for the given mode. */
export function apiPrepareAgent(project: string, mode: AgentPermissionMode): Promise<PrepareAgentResult> {
  return postJson<PrepareAgentResult>('/api/agent/prepare', { project, mode });
}
