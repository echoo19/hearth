/**
 * Node.js filesystem adapter, exported separately (`@hearth/core/node`) so
 * the main core entry stays browser-safe.
 */
import { promises as fsp } from 'node:fs';
import { accessSync } from 'node:fs';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FsLike } from '../fs.js';

export class NodeFileSystem implements FsLike {
  private resolve(p: string): string {
    return nodePath.resolve(p);
  }

  async readFile(path: string): Promise<string> {
    return fsp.readFile(this.resolve(path), 'utf8');
  }

  async readFileBinary(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fsp.readFile(this.resolve(path)));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const abs = this.resolve(path);
    await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }

  async appendFile(path: string, text: string): Promise<void> {
    const abs = this.resolve(path);
    await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
    await fsp.appendFile(abs, text, { flag: 'a' });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.access(this.resolve(path));
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await fsp.mkdir(this.resolve(path), { recursive: true });
  }

  async readdir(path: string): Promise<string[]> {
    return fsp.readdir(this.resolve(path));
  }

  async stat(path: string): Promise<{ isDirectory: boolean; size: number; mtimeMs: number }> {
    const s = await fsp.stat(this.resolve(path));
    return { isDirectory: s.isDirectory(), size: s.size, mtimeMs: s.mtimeMs };
  }

  async realpath(path: string): Promise<string> {
    const canonical = await fsp.realpath(this.resolve(path));
    // FsLike paths are POSIX-style even when the host is Windows.
    return nodePath.sep === '\\' ? canonical.replaceAll('\\', '/') : canonical;
  }

  async remove(path: string): Promise<void> {
    await fsp.rm(this.resolve(path), { recursive: true, force: true });
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const absDest = this.resolve(dest);
    await fsp.mkdir(nodePath.dirname(absDest), { recursive: true });
    await fsp.copyFile(this.resolve(src), absDest);
  }
}

export const nodeFs: FsLike = new NodeFileSystem();

// ---------------------------------------------------------------------------
// Web player bundle resolution (exportWeb)
// ---------------------------------------------------------------------------

/** Walk upward from this module looking for the hearth monorepo root. */
function findRepoRootFromModule(): string | null {
  let dir = nodePath.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    try {
      accessSync(nodePath.join(dir, 'packages', 'core', 'package.json'));
      return dir;
    } catch {
      /* keep walking */
    }
    const parent = nodePath.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Candidate paths for the built web player, in resolution order:
 * 1. $HEARTH_TOOLS_DIR/hearth-player.js (packaged desktop app)
 * 2. next to the running script (standalone hearth-cli.mjs / hearth-mcp.mjs downloads)
 * 3. packages/runtime/player/hearth-player.js (repo checkout)
 */
export function playerBundleCandidates(repoRoot?: string): string[] {
  const candidates: string[] = [];
  const toolsDir = process.env.HEARTH_TOOLS_DIR;
  if (toolsDir) candidates.push(nodePath.join(toolsDir, 'hearth-player.js'));
  if (process.argv[1]) candidates.push(nodePath.join(nodePath.dirname(process.argv[1]), 'hearth-player.js'));
  const root = repoRoot ?? findRepoRootFromModule();
  if (root) candidates.push(nodePath.join(root, 'packages', 'runtime', 'player', 'hearth-player.js'));
  return candidates;
}

/**
 * Load the built web player bundle (hearth-player.js) for exportWeb. Hosts
 * pass this as `resources.getPlayerBundle`. Throws with the checked locations
 * when no bundle is found.
 */
export async function loadPlayerBundle(repoRoot?: string): Promise<string> {
  const candidates = playerBundleCandidates(repoRoot);
  for (const candidate of candidates) {
    try {
      return await fsp.readFile(candidate, 'utf8');
    } catch {
      /* try the next location */
    }
  }
  throw new Error(
    `hearth-player.js not found. Looked in: ${candidates.join(', ') || '(no known locations)'}. ` +
      'Set HEARTH_TOOLS_DIR to a directory containing hearth-player.js, or build the runtime player ' +
      '(packages/runtime/player/hearth-player.js).',
  );
}
