/** Shared fixture plumbing for the adapter tests (not a test file itself). */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openWebGame, serveDir, type OpenWebGameOptions, type WebGameUnderTest } from '../src/index.js';
import type { StaticServer } from '../src/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES = path.resolve(HERE, '../fixtures');
export const RUNNER_DIR = path.join(FIXTURES, 'runner');
export const BLANK_DIR = path.join(FIXTURES, 'blank');
export const STATES_DIR = path.join(FIXTURES, 'states');

export interface OpenFixture {
  game: WebGameUnderTest;
  server: StaticServer;
  close(): Promise<void>;
}

/**
 * Serve a fixture directory and open it, optionally with a `?variant=` query.
 * Variants go through the adapter's ready-URL path (the same one a game with
 * its own dev server uses), which is why the server is created here.
 */
export async function openFixture(
  dir: string,
  opts: { variant?: string } & OpenWebGameOptions = {},
): Promise<OpenFixture> {
  const { variant, ...gameOpts } = opts;
  const server = await serveDir(dir);
  const url = variant ? `${server.url}?variant=${encodeURIComponent(variant)}` : server.url;
  const game = await openWebGame({ url, stepMs: 16, ...gameOpts });
  await game.start();
  return {
    game,
    server,
    close: async () => {
      await game.stop();
      await server.close();
    },
  };
}

/** PNG signature + IHDR dimensions; throws when the bytes aren't a PNG. */
export function readPngHeader(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24) throw new Error('not a PNG: too short');
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) throw new Error('not a PNG: bad signature');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (type !== 'IHDR') throw new Error(`not a PNG: first chunk is ${type}`);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Find the player entity in whatever the shim reported this step. */
export async function playerPos(game: WebGameUnderTest): Promise<{ x: number; y: number }> {
  const player = await game.findEntity?.('player');
  if (!player) throw new Error('runner fixture reported no player entity');
  return { x: player.x, y: player.y };
}
