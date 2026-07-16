import { HEARTH_VERSION } from '../schema/project.js';
import { ProjectError } from './store.js';

export interface ProjectMigration {
  fromBelow: string;
  describe: string;
  apply(projectDoc: Record<string, any>): void;
}

export const PROJECT_MIGRATIONS: readonly ProjectMigration[] = [];

function parseSemver(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
  const aa = parseSemver(a);
  const bb = parseSemver(b);
  if (!aa || !bb) return a.localeCompare(b);
  for (let i = 0; i < 3; i++) {
    const diff = aa[i] - bb[i];
    if (diff !== 0) return diff;
  }
  return 0;
}

export function applyProjectMigrations(
  raw: unknown,
  engineVersion: string = HEARTH_VERSION,
  migrations: readonly ProjectMigration[] = PROJECT_MIGRATIONS,
): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const rawDoc = raw as Record<string, unknown>;
  const projectVersion: string = typeof rawDoc.hearthVersion === 'string' ? rawDoc.hearthVersion : engineVersion;

  if (compareSemver(projectVersion, engineVersion) > 0) {
    throw new ProjectError(
      `Project was saved by Hearth ${projectVersion}, which is newer than this engine (${engineVersion}). Upgrade Hearth before opening it.`,
      'UNSUPPORTED_PROJECT_VERSION',
    );
  }

  const doc: Record<string, any> = structuredClone(raw) as Record<string, any>;
  const ordered = [...migrations].sort((a, b) => compareSemver(a.fromBelow, b.fromBelow));
  for (const migration of ordered) {
    if (compareSemver(projectVersion, migration.fromBelow) < 0) {
      migration.apply(doc);
    }
  }
  return doc;
}
