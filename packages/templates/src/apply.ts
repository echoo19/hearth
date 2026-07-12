/**
 * `applyTemplate` — scaffold a new Hearth project from a template directory.
 *
 * Copies the template tree into `targetDir`, then rewrites the project file's
 * `id` (a fresh `prj_` id from core's generator, so two projects made from the
 * same template never collide), `name`, and `description`. A later task wires
 * this into `hearth init` and the editor's "new project" flow.
 */
import { generateId } from '@hearth/core';
import type { FsLike } from '@hearth/core';

const PROJECT_FILE = 'hearth.json';

export interface ApplyTemplateOptions {
  name: string;
  description?: string;
}

export interface ApplyTemplateResult {
  /** Every file written under `targetDir`, as `targetDir`-relative POSIX paths. */
  files: string[];
}

/** POSIX join for the fs abstraction (paths are '/'-separated by contract). */
function join(...parts: string[]): string {
  return parts.filter((p) => p.length > 0).join('/').replace(/\/+/g, '/');
}

async function copyTree(fs: FsLike, src: string, dest: string, destRoot: string, files: string[]): Promise<void> {
  await fs.mkdir(dest);
  const entries = (await fs.readdir(src)).slice().sort();
  for (const entry of entries) {
    const from = join(src, entry);
    const to = join(dest, entry);
    const stat = await fs.stat(from);
    if (stat.isDirectory) {
      await copyTree(fs, from, to, destRoot, files);
    } else {
      await fs.copyFile(from, to);
      files.push(to.slice(destRoot.length + 1));
    }
  }
}

/**
 * Copy `templatePath` into `targetDir` and personalize the copied project.
 * `templatePath` is an on-disk path (from `getTemplatePath`); `targetDir` is
 * where the new project should live. Both are passed through `fs`.
 */
export async function applyTemplate(
  fs: FsLike,
  templatePath: string,
  targetDir: string,
  options: ApplyTemplateOptions,
): Promise<ApplyTemplateResult> {
  const files: string[] = [];
  await copyTree(fs, templatePath, targetDir, targetDir, files);

  const projectPath = join(targetDir, PROJECT_FILE);
  const raw = await fs.readFile(projectPath);
  const project = JSON.parse(raw) as Record<string, unknown>;
  project.id = generateId('prj');
  project.name = options.name;
  project.description = options.description ?? '';
  await fs.writeFile(projectPath, JSON.stringify(project, null, 2) + '\n');

  files.sort();
  return { files };
}
