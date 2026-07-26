import { HEARTH_VERSION } from '../schema/project.js';
import { ProjectError } from './store.js';

export interface ProjectMigration {
  fromBelow: string;
  describe: string;
  apply(projectDoc: Record<string, any>): void;
}

export const PROJECT_MIGRATIONS: readonly ProjectMigration[] = [];

/**
 * The last version of the retired 1.x game engine. Hearth reset its version
 * line to 0.1.0 at the agent-first pivot, so the app version no longer
 * increases monotonically across the whole history of stamped projects: a
 * project saved by 1.2.1 is *older* than one saved by 0.1.0 despite comparing
 * as newer. The "saved by a newer Hearth" guard below therefore ceilings at
 * whichever is higher — this line or the running engine — so 0.x…1.2.1
 * projects keep opening while genuinely unknown future stamps are still
 * refused. Remove this once the new line passes 1.2.1.
 */
export const RETIRED_ENGINE_MAX_VERSION = '1.2.1';

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

  const readableCeiling =
    compareSemver(RETIRED_ENGINE_MAX_VERSION, engineVersion) > 0 ? RETIRED_ENGINE_MAX_VERSION : engineVersion;

  if (compareSemver(projectVersion, readableCeiling) > 0) {
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
