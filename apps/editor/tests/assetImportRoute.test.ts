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

  it('classifies font uploads as font assets', async () => {
    // Real TTF files open with an sfnt version tag (0x00010000); the rest of
    // the bytes are irrelevant to import/classification, which only looks at
    // the extension.
    const ttf = Buffer.from([0x00, 0x01, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');
    const result = await ctx.importAssetFile(projectPath, 'Pixel.ttf', ttf);
    const body = result.body as Envelope;
    expect(body.success).toBe(true);
    expect(body.data?.asset?.type).toBe('font');
    expect(body.data?.asset?.path).toContain('assets/font/');
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

interface BatchEnvelope {
  success: boolean;
  command: string;
  data: {
    imported: { path: string; assetId: string; name: string; type: string }[];
    skipped: { path: string; code: string; message: string }[];
  } | null;
  errors: { code: string; message: string }[];
}

describe('POST /api/assets/import-batch handler', () => {
  let batchProject: string;

  beforeAll(async () => {
    const created = await ctx.createNewProject(path.join(tmpDir, 'batch-projects'), 'Batch Import Target');
    expect(created.status).toBe(200);
    batchProject = (created.body as { path: string }).path;
  });

  it('imports every file in one atomic importAssets call and reports original filenames', async () => {
    const result = await ctx.importAssetsBatch(batchProject, [
      { filename: 'coin.png', dataBase64: PNG_BYTES.toString('base64') },
      { filename: 'jump.wav', dataBase64: Buffer.from('RIFF....WAVEfmt ').toString('base64') },
    ], undefined);
    expect(result.status).toBe(200);
    const body = result.body as BatchEnvelope;
    expect(body.success).toBe(true);
    expect(body.command).toBe('importAssets');
    expect(body.data?.imported).toHaveLength(2);
    expect(body.data?.skipped).toHaveLength(0);
    const names = body.data?.imported.map((i) => i.path).sort();
    expect(names).toEqual(['coin.png', 'jump.wav']);

    // Staging directory is cleaned up after the batch.
    await expect(fsp.access(path.join(batchProject, 'assets', 'imported'))).rejects.toThrow();

    // Exactly one journal entry covers the whole batch.
    const journalPath = path.join(batchProject, '.hearth', 'log', 'commands.jsonl');
    const journalText = await fsp.readFile(journalPath, 'utf8');
    const entries = journalText.trim().split('\n').map((l) => JSON.parse(l));
    expect(entries.filter((e) => e.command === 'importAssets')).toHaveLength(1);
  });

  it('reports a bad upload (invalid base64/empty/oversize) as a skip without failing the whole batch', async () => {
    const result = await ctx.importAssetsBatch(batchProject, [
      { filename: 'good.png', dataBase64: PNG_BYTES.toString('base64') },
      { filename: 'empty.png', dataBase64: '' },
      { filename: 'noext', dataBase64: PNG_BYTES.toString('base64') },
    ], undefined);
    const body = (result.body as BatchEnvelope);
    expect(body.success).toBe(true);
    expect(body.data?.imported).toHaveLength(1);
    expect(body.data?.imported[0].path).toBe('good.png');
    expect(body.data?.skipped).toHaveLength(2);
    expect(body.data?.skipped.map((s) => s.path).sort()).toEqual(['empty.png', 'noext']);
  });

  it('applies a type override to every file in the batch', async () => {
    const result = await ctx.importAssetsBatch(
      batchProject,
      [
        { filename: 'blob-a.dat', dataBase64: PNG_BYTES.toString('base64') },
        { filename: 'blob-b.dat', dataBase64: PNG_BYTES.toString('base64') },
      ],
      'other',
    );
    const body = result.body as BatchEnvelope;
    expect(body.success).toBe(true);
    expect(body.data?.imported).toHaveLength(2);
    expect(body.data?.imported.every((i) => i.type === 'other')).toBe(true);
  });

  it('rejects missing project / empty files array', async () => {
    const noProject = (await ctx.importAssetsBatch(undefined, [{ filename: 'a.png', dataBase64: 'aGk=' }], undefined))
      .body as BatchEnvelope;
    expect(noProject.success).toBe(false);
    expect(noProject.errors[0].code).toBe('NO_PROJECT');

    const empty = (await ctx.importAssetsBatch(batchProject, [], undefined)).body as BatchEnvelope;
    expect(empty.success).toBe(false);
    expect(empty.errors[0].code).toBe('INVALID_INPUT');
  });
});
