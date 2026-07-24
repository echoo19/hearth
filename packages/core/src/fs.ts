/**
 * Filesystem abstraction.
 *
 * Core must stay browser-safe (the editor UI imports it), so it never touches
 * `node:fs` directly. Node environments (CLI, MCP server, editor dev server)
 * pass a `NodeFileSystem` from `@hearth/core/node`; tests can use
 * `MemoryFileSystem`.
 *
 * All paths passed through this interface are POSIX-style ('/' separators),
 * absolute or project-root relative depending on the call site.
 */

export interface FsLike {
  readFile(path: string): Promise<string>;
  readFileBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  /** Append `text` to `path`, creating the file (and its parent dirs) if absent. Used by the append-only command journal. */
  appendFile(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory: boolean; size: number; mtimeMs: number }>;
  /** Canonical path when the host can resolve symlinks. */
  realpath?(path: string): Promise<string>;
  remove(path: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
}

/** Join POSIX-style path segments (used for project-internal paths). */
export function joinPath(...segments: string[]): string {
  const joined = segments
    .filter((s) => s.length > 0)
    .join('/')
    .replace(/\/+/g, '/');
  // Resolve '.' and '..' segments.
  const parts: string[] = [];
  for (const part of joined.split('/')) {
    if (part === '' && parts.length > 0) continue;
    if (part === '.') continue;
    if (part === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..' && parts[parts.length - 1] !== '') {
        parts.pop();
        continue;
      }
    }
    parts.push(part);
  }
  return parts.join('/') || '.';
}

export function dirnamePath(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return idx === 0 ? '/' : '.';
  return path.slice(0, idx);
}

/**
 * True when an output path is safely project-relative: no absolute paths
 * (POSIX or Windows drive-letter) and no `..` traversal, so writes through
 * it can never escape the project root. Shared by every command/tool that
 * accepts a user- or agent-supplied output path (buildProject, exportWeb,
 * hearth screenshot's --out). Stricter than isSafeRelativePath below: any
 * `..` segment is rejected outright, even one that would normalize away —
 * output paths have no legitimate use for traversal.
 */
export function isSafeOut(p: string): boolean {
  return !p.startsWith('/') && !p.includes('..') && !/^[a-zA-Z]:/.test(p);
}

export function basenamePath(path: string): string {
  // Callers pass OS paths too (importAsset source files), so split on both
  // separators — Windows absolute paths use backslashes.
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Guard against path escape: returns true if `relative` stays inside the
 * project root when joined. Agents must not be able to read/write outside
 * the project via crafted paths.
 */
export function isSafeRelativePath(relative: string): boolean {
  if (relative.startsWith('/') || /^[a-zA-Z]:/.test(relative)) return false;
  const normalized = joinPath(relative);
  return !normalized.startsWith('..') && normalized !== '..';
}

/** Simple in-memory filesystem for tests and browser demos. */
export class MemoryFileSystem implements FsLike {
  private files = new Map<string, string | Uint8Array>();
  private dirs = new Set<string>(['/']);

  private norm(path: string): string {
    return joinPath(path.startsWith('/') ? path : '/' + path);
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(this.norm(path));
    if (value === undefined) throw new Error(`ENOENT: no such file: ${path}`);
    return typeof value === 'string' ? value : new TextDecoder().decode(value);
  }

  async readFileBinary(path: string): Promise<Uint8Array> {
    const value = this.files.get(this.norm(path));
    if (value === undefined) throw new Error(`ENOENT: no such file: ${path}`);
    return typeof value === 'string' ? new TextEncoder().encode(value) : value;
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const p = this.norm(path);
    // Auto-create parent directories (mirrors mkdir -p semantics used by NodeFileSystem).
    let dir = dirnamePath(p);
    while (dir && dir !== '/' && dir !== '.') {
      this.dirs.add(dir);
      dir = dirnamePath(dir);
    }
    this.files.set(p, content);
  }

  async appendFile(path: string, text: string): Promise<void> {
    const p = this.norm(path);
    const existing = this.files.get(p);
    const prior = existing === undefined ? '' : typeof existing === 'string' ? existing : new TextDecoder().decode(existing);
    await this.writeFile(p, prior + text);
  }

  async exists(path: string): Promise<boolean> {
    const p = this.norm(path);
    return this.files.has(p) || this.dirs.has(p);
  }

  async mkdir(path: string): Promise<void> {
    const p = this.norm(path);
    let dir = p;
    while (dir && dir !== '/' && dir !== '.') {
      this.dirs.add(dir);
      dir = dirnamePath(dir);
    }
  }

  async readdir(path: string): Promise<string[]> {
    const p = this.norm(path);
    const out = new Set<string>();
    const prefix = p === '/' ? '/' : p + '/';
    for (const key of [...this.files.keys(), ...this.dirs]) {
      if (key !== p && key.startsWith(prefix)) {
        const rest = key.slice(prefix.length);
        const first = rest.split('/')[0];
        if (first) out.add(first);
      }
    }
    return [...out].sort();
  }

  async stat(path: string): Promise<{ isDirectory: boolean; size: number; mtimeMs: number }> {
    const p = this.norm(path);
    if (this.dirs.has(p) && !this.files.has(p)) {
      return { isDirectory: true, size: 0, mtimeMs: 0 };
    }
    const value = this.files.get(p);
    if (value === undefined) throw new Error(`ENOENT: no such file: ${path}`);
    const size = typeof value === 'string' ? value.length : value.byteLength;
    return { isDirectory: false, size, mtimeMs: 0 };
  }

  async realpath(path: string): Promise<string> {
    return this.norm(path);
  }

  async remove(path: string): Promise<void> {
    const p = this.norm(path);
    this.files.delete(p);
    this.dirs.delete(p);
    const prefix = p + '/';
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(prefix)) this.files.delete(key);
    }
    for (const key of [...this.dirs]) {
      if (key.startsWith(prefix)) this.dirs.delete(key);
    }
  }

  async copyFile(src: string, dest: string): Promise<void> {
    const value = this.files.get(this.norm(src));
    if (value === undefined) throw new Error(`ENOENT: no such file: ${src}`);
    await this.writeFile(dest, value);
  }
}
