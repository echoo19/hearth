/**
 * Tests for the asset-import route handler (POST /api/assets/import dispatches
 * to ctx.importAssetFile): filename sanitization, extension/size limits, and
 * the staged-file → importAsset command → cleanup flow.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  createProjectServerContext,
  sanitizeImportFilename,
  MAX_IMPORT_BYTES,
  type ProjectServerContext,
} from '../server/projectServer';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let tmpDir: string;
let projectPath: string;
let ctx: ProjectServerContext;

interface Envelope {
  success: boolean;
  command: string;
  data: { asset?: { id: string; name: string; type: string; path: string } } | null;
  errors: { code: string; message: string }[];
}

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'hearth-import-route-'));
  ctx = createProjectServerContext({
    recentsFile: path.join(tmpDir, 'recent-projects.json'),
    repoRoot: tmpDir,
  });
  const created = await ctx.createNewProject(path.join(tmpDir, 'projects'), 'Import Target');
  expect(created.status).toBe(200);
  projectPath = (created.body as { path: string }).path;
});

afterAll(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('sanitizeImportFilename', () => {
  it('keeps ordinary names', () => {
    expect(sanitizeImportFilename('hero.png')).toBe('hero.png');
    expect(sanitizeImportFilename('My Track (final).mp3')).toBe('My-Track-final-.mp3');
  });

  it('strips directories and traversal attempts', () => {
    expect(sanitizeImportFilename('../../etc/passwd.png')).toBe('passwd.png');
    expect(sanitizeImportFilename('C:\\Users\\evil\\..\\boot.png')).toBe('boot.png');
    expect(sanitizeImportFilename('assets/nested/tile.png')).toBe('tile.png');
  });

  it('rejects names without a usable stem or extension', () => {
    expect(sanitizeImportFilename('')).toBeNull();
    expect(sanitizeImportFilename('..')).toBeNull();
    expect(sanitizeImportFilename('.hidden')).toBeNull();
    expect(sanitizeImportFilename('noextension')).toBeNull();
    expect(sanitizeImportFilename('trailingdot.')).toBeNull();
  });
});

describe('POST /api/assets/import handler', () => {
  it('imports an image and registers it through the importAsset command', async () => {
    const result = await ctx.importAssetFile(projectPath, 'hero.png', PNG_BYTES.toString('base64'));
    expect(result.status).toBe(200);
    const body = result.body as Envelope;
    expect(body.success).toBe(true);
    expect(body.command).toBe('importAsset');
    const asset = body.data?.asset;
    expect(asset?.type).toBe('sprite');
    expect(asset?.name).toBe('hero');

    // The registered file exists and matches the uploaded bytes...
    const written = await fsp.readFile(path.join(projectPath, asset!.path));
    expect(Buffer.compare(written, PNG_BYTES)).toBe(0);
    // ...and the staging copy under assets/imported/ was cleaned up.
    await expect(fsp.access(path.join(projectPath, 'assets', 'imported', 'hero.png'))).rejects.toThrow();
  });

  it('classifies audio uploads as audio assets', async () => {
    const wav = Buffer.from('RIFF....WAVEfmt ').toString('base64');
    const result = await ctx.importAssetFile(projectPath, 'coin.wav', wav);
    const body = result.body as Envelope;
    expect(body.success).toBe(true);
    expect(body.data?.asset?.type).toBe('audio');
    expect(body.data?.asset?.path).toContain('assets/audio/');
  });

  it('reports a conflict when the same file is imported twice', async () => {
    const result = await ctx.importAssetFile(projectPath, 'hero.png', PNG_BYTES.toString('base64'));
    const body = result.body as Envelope;
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('CONFLICT');
  });

  it('rejects unknown extensions', async () => {
    const result = await ctx.importAssetFile(projectPath, 'game.exe', PNG_BYTES.toString('base64'));
    const body = result.body as Envelope;
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('INVALID_INPUT');
    expect(body.errors[0].message).toContain('.exe');
  });

  it('rejects files over the size limit', async () => {
    const big = Buffer.alloc(MAX_IMPORT_BYTES + 1).toString('base64');
    const result = await ctx.importAssetFile(projectPath, 'huge.png', big);
    const body = result.body as Envelope;
    expect(body.success).toBe(false);
    expect(body.errors[0].code).toBe('INVALID_INPUT');
    expect(body.errors[0].message).toContain('25 MB');
  });

  it('sanitizes traversal in the uploaded filename', async () => {
    const result = await ctx.importAssetFile(
      projectPath,
      '../../outside.png',
      PNG_BYTES.toString('base64'),
    );
    const body = result.body as Envelope;
    expect(body.success).toBe(true);
    expect(body.data?.asset?.path).toBe('assets/sprites/outside.png');
    // Nothing escaped the project.
    await expect(fsp.access(path.join(tmpDir, 'outside.png'))).rejects.toThrow();
    await expect(fsp.access(path.join(tmpDir, 'projects', 'outside.png'))).rejects.toThrow();
  });

  it('rejects missing project / bad payloads with the standard envelope', async () => {
    const noProject = (await ctx.importAssetFile(undefined, 'a.png', 'aGk=')).body as Envelope;
    expect(noProject.success).toBe(false);
    expect(noProject.errors[0].code).toBe('NO_PROJECT');

    const noData = (await ctx.importAssetFile(projectPath, 'a.png', '')).body as Envelope;
    expect(noData.success).toBe(false);
    expect(noData.errors[0].code).toBe('INVALID_INPUT');

    const badName = (await ctx.importAssetFile(projectPath, '.env', 'aGk=')).body as Envelope;
    expect(badName.success).toBe(false);
    expect(badName.errors[0].code).toBe('INVALID_INPUT');
  });
});
