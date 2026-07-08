/**
 * Client-side shapes for data crossing the /api boundary.
 * Command payload types mirror what the core inspect commands return.
 */
import type { CommandResult, InputMappings, JournalEntry, ProjectDiff } from '@hearth/core';

export type { CommandResult, JournalEntry, ProjectDiff };

export interface Vec2 {
  x: number;
  y: number;
}

export interface SceneListItem {
  id: string;
  name: string;
  path: string;
  entityCount: number;
}

export interface BuildSettings {
  width: number;
  height: number;
  backgroundColor: string;
  targetFps: number;
  fixedTimestep: number;
  title: string;
}

export interface ProjectInfo {
  id: string;
  name: string;
  description: string;
  hearthVersion: string;
  formatVersion: number;
  initialScene: string | null;
  scenes: SceneListItem[];
  assetCount: number;
  scriptCount: number;
  playtestCount: number;
  inputActions: Record<string, string[]>;
  inputMappings: InputMappings;
  buildSettings: BuildSettings;
}

/** Entity shape from inspectScene with full=true. */
export interface SceneEntity {
  id: string;
  name: string;
  parentId: string | null;
  enabled: boolean;
  tags: string[];
  components: Record<string, Record<string, unknown>>;
  position: Vec2 | null;
  children: string[];
  /** Set on a prefab instance's root entity only; links back to the source asset. */
  prefab?: { asset: string };
}

export interface SceneData {
  id: string;
  name: string;
  isInitial: boolean;
  entityCount: number;
  entities: SceneEntity[];
}

export interface AssetItem {
  id: string;
  name: string;
  type: 'sprite' | 'tile' | 'audio' | 'animation' | 'font' | 'data' | 'other' | 'prefab';
  path: string;
  metadata: Record<string, unknown>;
  /** Fresh-from-disk summary attached by inspectAssets for `type: 'prefab'` assets only. */
  prefab?: { entityCount: number; rootComponents: string[] };
}

export interface ComponentDoc {
  type: string;
  description: string;
  defaults: Record<string, unknown>;
  /** Enum options per field (e.g. `{ shape: ['rectangle', 'circle', ...] }`), empty when the component has none. */
  enums: Record<string, string[]>;
}

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  scene?: string;
  entity?: string;
  asset?: string;
  script?: string;
}

export interface ValidationReport {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ServerMeta {
  repoRoot: string;
  home: string;
  hearthVersion: string;
  runtimeAvailable: boolean;
  /** Where the agent tools live (bundled single files in the desktop app). */
  toolPaths?: { cli: string; mcp: string; bundled: boolean };
}

export interface RecentProject {
  path: string;
  name: string;
  exists: boolean;
}

export interface ExampleProject {
  path: string;
  name: string;
  description: string;
}

export type ConsoleLevel = 'info' | 'warn' | 'error';
export type ConsoleSource = 'command' | 'runtime' | 'validate' | 'editor';

export interface ConsoleEntry {
  id: number;
  time: string; // HH:MM:SS
  level: ConsoleLevel;
  source: ConsoleSource;
  message: string;
}

/** One entry from the `listHistory` command. `undone` means it's ahead of the cursor (redoable). */
export interface HistoryEntry {
  seq: number;
  command: string;
  summary: string;
  timestamp: string;
  undone: boolean;
}

export interface HistoryList {
  entries: HistoryEntry[];
  cursor: number;
}
