/**
 * Node.js filesystem adapter, exported separately (`@hearth/core/node`) so
 * the main core entry stays browser-safe.
 */
import { promises as fsp } from 'node:fs';
import nodePath from 'node:path';
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
