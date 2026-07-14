/**
 * `scaffoldFromTemplate` — turn a genre template directory into a complete,
 * personalized Hearth project.
 *
 * `applyTemplate` copies the template's gameplay content (project.json, scenes,
 * scripts, assets) and rewrites the project's `id`/`name`/`description`, but it
 * deliberately leaves two classes of file wrong for a scaffolded project:
 *
 *   - `.hearth/agent-config.json`, `AGENTS.md`, and `CLAUDE.md` are copied
 *     verbatim, so they still carry the *template's* name and `prj_` id.
 *   - `.gitignore` is skipped entirely (see `apply.ts`).
 *
 * This helper pairs `applyTemplate` with `createProject`'s freshness semantics:
 * after the copy it regenerates the agent integration files (from core's
 * generators, the same ones `createProject` uses) with the new name and the
 * freshly-minted project id, and writes the standard project `.gitignore`. The
 * result is a project indistinguishable — in its non-gameplay scaffolding —
 * from one made by `createProject`, but with the template's content. Both
 * `hearth init --template` and the editor's create-project route call this so
 * there is one source of truth for "scaffold a project from a template".
 */
import {
  generateAgentConfig,
  generateAgentsMd,
  generateClaudeMd,
  PROJECT_GITIGNORE,
  AGENT_SKILL_CONTENT,
  AGENT_SKILL_FILE,
} from '@hearth/core';
import type { FsLike } from '@hearth/core';
import { applyTemplate, type ApplyTemplateOptions, type ApplyTemplateResult } from './apply.js';

const PROJECT_FILE = 'hearth.json';
const AGENT_CONFIG_FILE = '.hearth/agent-config.json';
const AGENTS_FILE = 'AGENTS.md';
const CLAUDE_FILE = 'CLAUDE.md';
const GITIGNORE_FILE = '.gitignore';

/** POSIX join for the fs abstraction (paths are '/'-separated by contract). */
function join(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
}

/**
 * Copy `templatePath` into `targetDir` and produce a fully-personalized
 * project: template content from the template, but fresh agent-config,
 * AGENTS.md, CLAUDE.md, and .gitignore for `options.name`. Returns every file
 * written under `targetDir` (targetDir-relative POSIX paths, sorted).
 */
export async function scaffoldFromTemplate(
  fs: FsLike,
  templatePath: string,
  targetDir: string,
  options: ApplyTemplateOptions,
): Promise<ApplyTemplateResult> {
  const { files } = await applyTemplate(fs, templatePath, targetDir, options);

  // applyTemplate has already written a fresh `prj_` id into hearth.json; read
  // it back so the regenerated agent-config's projectId matches exactly.
  const project = JSON.parse(await fs.readFile(join(targetDir, PROJECT_FILE))) as { id: string };

  await fs.writeFile(
    join(targetDir, AGENT_CONFIG_FILE),
    JSON.stringify(generateAgentConfig(options.name, project.id), null, 2) + '\n',
  );
  await fs.writeFile(join(targetDir, AGENTS_FILE), generateAgentsMd(options.name));
  await fs.writeFile(join(targetDir, CLAUDE_FILE), generateClaudeMd(options.name));
  await fs.writeFile(join(targetDir, GITIGNORE_FILE), PROJECT_GITIGNORE);
  // Rewrite the best-practices skill from core's embedded canonical copy rather
  // than trusting the template's (possibly stale) copy, matching createProject.
  await fs.writeFile(join(targetDir, AGENT_SKILL_FILE), AGENT_SKILL_CONTENT);

  // applyTemplate copies agent-config/AGENTS/CLAUDE and the skill file, so they
  // are already in `files`; .gitignore is regenerated here and must be added.
  const all = new Set(files);
  all.add(GITIGNORE_FILE);
  all.add(AGENT_CONFIG_FILE);
  all.add(AGENTS_FILE);
  all.add(CLAUDE_FILE);
  all.add(AGENT_SKILL_FILE);
  return { files: [...all].sort() };
}
