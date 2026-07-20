/**
 * Tests for `captureSequence`: the frame-sequence contact-sheet capture.
 *
 * Pure grid/frame math (`computeFrames`, `gridDimensions`) runs
 * unconditionally; the real Chromium capture is gated behind
 * canLaunchChromium() so this suite still passes where no Chrome/Chromium is
 * available (same it.skipIf pattern as screenshot.test.ts).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createProject, type ProjectStore } from '@hearth/core';
import { NodeFileSystem } from '@hearth/core/node';
import {
  captureSequence,
  computeFrames,
  gridDimensions,
  MAX_SEQUENCE_FRAMES,
} from '../src/capture.js';
import { canLaunchChromium } from '../src/screenshot.js';

// ---------------------------------------------------------------------------
// Pure helpers — no Chromium.
// ---------------------------------------------------------------------------

describe('gridDimensions', () => {
  it('lays out a single frame as 1x1', () => {
    expect(gridDimensions(1)).toEqual({ cols: 1, rows: 1 });
  });

  it('lays out a perfect square with equal cols and rows', () => {
    expect(gridDimensions(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridDimensions(9)).toEqual({ cols: 3, rows: 3 });
  });

  it('uses cols = ceil(sqrt(n)) and just enough rows for near-square layouts', () => {
    // 8 -> cols 3, rows 3 (last cell empty); 32 -> cols 6, rows 6.
    expect(gridDimensions(8)).toEqual({ cols: 3, rows: 3 });
    expect(gridDimensions(6)).toEqual({ cols: 3, rows: 2 });
    expect(gridDimensions(32)).toEqual({ cols: 6, rows: 6 });
  });

  it('always has enough cells for every frame', () => {
    for (let n = 1; n <= 64; n++) {
      const { cols, rows } = gridDimensions(n);
      expect(cols * rows).toBeGreaterThanOrEqual(n);
    }
  });
});

describe('computeFrames', () => {
  it('captures every integer frame inclusive when the range is small', () => {
    expect(computeFrames(0, 5, 1)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('honours an explicit step and stays inclusive of from', () => {
    expect(computeFrames(0, 10, 2)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(computeFrames(3, 12, 3)).toEqual([3, 6, 9, 12]);
  });

  it('defaults to a step that keeps the count at or under 32', () => {
    const frames = computeFrames(0, 120);
    expect(frames.length).toBeLessThanOrEqual(32);
    expect(frames[0]).toBe(0);
    // The largest captured frame never exceeds `to`.
    expect(frames[frames.length - 1]).toBeLessThanOrEqual(120);
  });

  it('returns a single frame when from equals to', () => {
    expect(computeFrames(4, 4)).toEqual([4]);
  });

  it('rejects a range where to < from', () => {
    expect(() => computeFrames(10, 5)).toThrow(/"to".*"from"/i);
  });

  it('rejects a non-positive explicit step', () => {
    expect(() => computeFrames(0, 10, 0)).toThrow(/step/i);
    expect(() => computeFrames(0, 10, -2)).toThrow(/step/i);
  });
});

// ---------------------------------------------------------------------------
// captureSequence option validation — no Chromium needed.
// ---------------------------------------------------------------------------

async function makeRealStore(): Promise<{ store: ProjectStore; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hearth-capture-test-'));
  const fs = new NodeFileSystem();
  const { store } = await createProject(fs, root, { name: 'Capture Test Game' });
  return { store, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** Parse an 8-bit PNG's IHDR width/height (offset 16: after sig + len + "IHDR"). */
function readPngSize(bytes: Buffer): { width: number; height: number } {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('captureSequence option validation', () => {
  it('rejects an unknown scene before ever touching Chromium', async () => {
    const { store, cleanup } = await makeRealStore();
    try {
      await expect(captureSequence(store, { scene: 'NoSuchScene', to: 4 })).rejects.toThrow(
        /scene not found/i,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects an absolute outPath', async () => {
    const { store, cleanup } = await makeRealStore();
    try {
      await expect(captureSequence(store, { to: 4, outPath: '/tmp/evil.png' })).rejects.toThrow(
        /project-relative path/,
      );
    } finally {
      await cleanup();
    }
  });

  it('rejects an outPath with .. traversal', async () => {
    const { store, cleanup } = await makeRealStore();
    try {
      await expect(captureSequence(store, { to: 4, outPath: '../escape.png' })).rejects.toThrow(
        /project-relative path/,
      );
    } finally {
      await cleanup();
    }
  });

  it('errors when the requested frame count exceeds the hard cap, telling the caller to raise step', async () => {
    const { store, cleanup } = await makeRealStore();
    try {
      // Explicit step 1 over a 0..100 range = 101 frames, well over the cap.
      await expect(captureSequence(store, { to: 100, step: 1, outPath: 'seq.png' })).rejects.toThrow(
        new RegExp(`${MAX_SEQUENCE_FRAMES}[\\s\\S]*step`, 'i'),
      );
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Real Chromium capture — gated so this suite passes with no browser present.
// ---------------------------------------------------------------------------
const hasChromium = await canLaunchChromium();

describe('captureSequence (real Chromium)', () => {
  it.skipIf(!hasChromium)(
    'produces a single contact-sheet PNG sized cols x rows of the per-frame tile',
    async () => {
      const { store, cleanup } = await makeRealStore();
      try {
        const size = { width: 120, height: 80 };
        const result = await captureSequence(store, {
          from: 0,
          to: 5,
          step: 1,
          seed: 1,
          size,
          outPath: 'shots/sheet.png',
        });

        // 6 frames -> cols 3, rows 2.
        expect(result.frames).toEqual([0, 1, 2, 3, 4, 5]);
        expect(result.sheet).toEqual({ cols: 3, rows: 2 });
        expect(result.size).toEqual(size);
        expect(result.outPaths).toHaveLength(1);
        expect(result.outPaths[0].endsWith(path.join('shots', 'sheet.png'))).toBe(true);

        const bytes = await readFile(result.outPaths[0]);
        expect(bytes.length).toBeGreaterThan(500);
        const dims = readPngSize(bytes);
        expect(dims.width).toBe(3 * size.width);
        expect(dims.height).toBe(2 * size.height);

        // Scratch export dir fully cleaned up after success.
        await expect(pathExists(path.join(store.root, '.hearth-tmp'))).resolves.toBe(false);
      } finally {
        await cleanup();
      }
    },
    60_000,
  );

  it.skipIf(!hasChromium)(
    'with sheet=false emits one PNG per frame, numbered in the filename',
    async () => {
      const { store, cleanup } = await makeRealStore();
      try {
        const result = await captureSequence(store, {
          from: 0,
          to: 6,
          step: 2,
          seed: 2,
          size: { width: 96, height: 64 },
          sheet: false,
          outPath: 'shots/frames.png',
        });

        expect(result.frames).toEqual([0, 2, 4, 6]);
        expect(result.outPaths).toHaveLength(4);
        for (const frame of result.frames) {
          const expected = path.join('shots', `frames-f${frame}.png`);
          const match = result.outPaths.find((p) => p.endsWith(expected));
          expect(match, `expected a file ending in ${expected}`).toBeDefined();
          const info = await stat(match!);
          expect(info.size).toBeGreaterThan(300);
        }
      } finally {
        await cleanup();
      }
    },
    60_000,
  );

  it.skipIf(!hasChromium)(
    'is deterministic: two contact sheets at the same seed produce identical bytes',
    async () => {
      const { store, cleanup } = await makeRealStore();
      try {
        const common = { from: 0, to: 4, step: 1, seed: 7, size: { width: 100, height: 100 } };
        const a = await captureSequence(store, { ...common, outPath: 'shots/a.png' });
        const b = await captureSequence(store, { ...common, outPath: 'shots/b.png' });
        const [bytesA, bytesB] = await Promise.all([
          readFile(a.outPaths[0]),
          readFile(b.outPaths[0]),
        ]);
        expect(Buffer.compare(bytesA, bytesB)).toBe(0);
      } finally {
        await cleanup();
      }
    },
    60_000,
  );
});
