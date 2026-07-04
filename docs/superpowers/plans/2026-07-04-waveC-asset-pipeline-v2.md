# Wave C — Asset Pipeline v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real art, real sound, real typography: spritesheet slicing + sub-rect rendering + tint, streamed music with fades, working font assets, an `assertAudioCount` playtest assertion, editor slice/preview UX, and a seventh example game built from imported binary assets.

**Architecture:** Frames are typed regions stored in the sheet asset's `metadata.frames`, read only through core accessors; SpriteRenderer gains a `frame` field the renderer maps to cached sub-textures. Music is a single session-scoped channel (`ctx.audio.playMusic/stopMusic/setMusicVolume`) whose state object is owned by GameSession and shared into each SceneRuntime so it survives scene switches; the web host streams via MediaElementSource. Fonts load through the FontFace API at preload, keyed by asset name.

**Tech Stack:** TypeScript ESM NodeNext, Zod, PixiJS v8, Web Audio + HTMLMediaElement, vitest (root, no build), node:zlib for the example's PNG fixture generator.

**Spec:** `docs/superpowers/specs/2026-07-04-waveC-asset-pipeline-v2-design.md` — the spec's prose governs wherever this plan's sample code and the spec disagree.

## Global Constraints

- **Typecheck every task**: `npm run typecheck` must pass alongside `npx vitest run` — vitest does NOT typecheck (standing rule; a green suite once shipped a TS build break).
- Tests run from repo root: `npx vitest run <path>`; aliases map `@hearth/*` to src, no build needed.
- TS ESM NodeNext: relative imports need `.js` suffix.
- Zod schemas must have full defaults so `{}` parses valid; new fields must not change the parse of existing project JSON (backward compatible defaults: `frame: null`, `music: false`).
- Determinism untouched: nothing in this wave may read wall-clock/Math.random inside the simulation; audio/fonts are presentation-side.
- `metadata.frames` is read ONLY via `getSheetFrames`/`findSheetFrame` (core accessors) — no site re-parses it by hand.
- Frame refs written to `.anim.json` files always use asset **ids** before `#` (names resolved at creation time).
- Music channel semantics: ONE channel; `playMusic` replaces current (old track fades out over the new call's `fadeIn` seconds); `stopMusic`/`setMusicVolume` with no music playing are no-ops; music survives scene switches; `stopAllAudio` (SFX teardown) never touches music; `setMusicVolume` is never recorded in `audioEvents`.
- Texture tint: `SpriteRenderer.color` multiplies textured sprites; default `#ffffff` must render existing projects pixel-identically.
- Editor UI: uniform typed controls, never raw JSON (Jake's bar); no engine chrome in shipped games.
- Examples are GENERATED: edit `packages/examples/generate.mjs` and rerun; never hand-edit example project JSON. Playtest expectations are baked from probe runs, never hand-computed.
- Version stays 0.5.0 until Task 14 (the bump task).
- Commit messages: plain human voice, no AI attribution, no emoji.

## File Structure (new files)

- `packages/core/src/assets/imageInfo.ts` — pure byte-level image probing.
- `packages/core/src/assets/sheetFrames.ts` — SpritesheetFrame accessors.
- `packages/core/test/imageInfo.test.ts`, `packages/core/test/spritesheet.test.ts`, `packages/core/test/animationFromSheet.test.ts`
- `packages/runtime/test/music.test.ts`, `packages/runtime/test/spriteFrame.test.ts`
- `packages/examples/fixtures/fonts/press-start-2p.ttf` + `OFL.txt` — ALREADY COMMITTED by the controller; do not re-download.
- `packages/examples/pixelart.mjs` — deterministic PNG + WAV fixture generators for Sky Courier.
- `docs/assets.md` — asset pipeline documentation.

Everything else modifies existing files (exact anchors per task).

---

### Task 1: Image probing (`probeImage`) + importAsset metadata

**Files:**
- Create: `packages/core/src/assets/imageInfo.ts`
- Modify: `packages/core/src/commands/assetCommands.ts` (importAsset, ~line 57-80; EXT_TO_TYPE ~line 28)
- Modify: `packages/core/src/index.ts` (export the new module — follow the existing export list style)
- Test: `packages/core/test/imageInfo.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `probeImage(bytes: Uint8Array): ImageInfo | null` with `interface ImageInfo { width: number; height: number; format: 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' }`. Task 2's slice command calls this. Also: `EXT_TO_TYPE` gains `woff: 'font'` (spec §4.4, folded here since it's the same table).

- [ ] **Step 1: Write failing tests** — `packages/core/test/imageInfo.test.ts`. Build fixtures as raw bytes in the test file (no binary files):
  - PNG: signature `89 50 4E 47 0D 0A 1A 0A` + IHDR chunk with width 130, height 64 (big-endian u32 at offsets 16/20). Assert `{width: 130, height: 64, format: 'png'}`.
  - GIF: `GIF89a` + logical screen 40×30 little-endian u16 at offsets 6/8.
  - JPEG: `FF D8` + an APP0 segment + a SOF0 (`FF C0`) segment with height 24 / width 32 (big-endian u16 at SOF payload offsets 3/5 — i.e. marker offset +5/+7). Include a dummy segment before SOF0 to prove the scanner walks segments.
  - WebP lossy: `RIFF....WEBPVP8 ` with the 3-byte sync `9D 01 2A` at chunk payload offset 3 and 14-bit dims (u16 LE & 0x3fff) — encode 16×8.
  - WebP lossless: `WEBPVP8L`, payload byte 0 = `0x2F`, then the 28-bit packed dims for 17×9 (`width-1 = 16` in bits 0–13, `height-1 = 8` in bits 14–27).
  - SVG with `width="64" height="32"`; SVG with only `viewBox="0 0 48 24"` (expect 48×24); SVG with neither (expect null).
  - Garbage bytes and empty array → null. Truncated PNG (8 bytes) → null.
- [ ] **Step 2: Run to verify failure** — `npx vitest run packages/core/test/imageInfo.test.ts` → module not found.
- [ ] **Step 3: Implement** `packages/core/src/assets/imageInfo.ts`:

```ts
/** Byte-level image dimension probing. No dependencies, never throws. */
export interface ImageInfo {
  width: number;
  height: number;
  format: 'png' | 'jpeg' | 'gif' | 'webp' | 'svg';
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}
function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}
function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}
function ascii(b: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}

function probeJpeg(b: Uint8Array): ImageInfo | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    let marker = b[i + 1];
    while (marker === 0xff && i + 2 < b.length) {
      i++;
      marker = b[i + 1];
    }
    // Standalone markers without a length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return { width: u16be(b, i + 7), height: u16be(b, i + 5), format: 'jpeg' };
    }
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function probeWebp(b: Uint8Array): ImageInfo | null {
  const kind = ascii(b, 12, 16);
  if (kind === 'VP8 ' && b.length >= 30) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff, format: 'webp' };
  }
  if (kind === 'VP8L' && b.length >= 25) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
  }
  if (kind === 'VP8X' && b.length >= 30) {
    const w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
    const h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
    return { width: w, height: h, format: 'webp' };
  }
  return null;
}

function probeSvg(b: Uint8Array): ImageInfo | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: false }).decode(b.slice(0, 4096));
  } catch {
    return null;
  }
  const open = text.match(/<svg\b[^>]*>/i);
  if (!open) return null;
  const tag = open[0];
  const dim = (attr: string): number | null => {
    const m = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']\\s*([0-9.]+)\\s*(?:px)?\\s*["']`, 'i'));
    if (!m) return null;
    const v = Math.round(parseFloat(m[1]));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const w = dim('width');
  const h = dim('height');
  if (w && h) return { width: w, height: h, format: 'svg' };
  const vb = tag.match(/\bviewBox\s*=\s*["']\s*([-0-9.]+)[\s,]+([-0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)\s*["']/i);
  if (vb) {
    const vw = Math.round(parseFloat(vb[3]));
    const vh = Math.round(parseFloat(vb[4]));
    if (vw > 0 && vh > 0) return { width: vw, height: vh, format: 'svg' };
  }
  return null;
}

/** Probe width/height/format from image bytes. Null when unrecognized or dimensionless. */
export function probeImage(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20), format: 'png' };
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: u16le(bytes, 6), height: u16le(bytes, 8), format: 'gif' };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return probeJpeg(bytes);
  if (bytes.length >= 16 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return probeWebp(bytes);
  }
  return probeSvg(bytes);
}
```

- [ ] **Step 4: Wire into importAsset** — in `assetCommands.ts`: add `woff: 'font'` to `EXT_TO_TYPE`. In `importAsset.run`, after the `copyFile`, when `type === 'sprite' || type === 'tile'`: read the copied file with `ctx.fs.readFileBinary(destPath)` (see `exportCommands.ts:223` for prior use), call `probeImage`; when non-null, spread `{ width: info.width, height: info.height, format: info.format }` into the registered asset's `metadata` (alongside `importedFrom`). Wrap the read+probe in try/catch — failure must not fail the import. Add an importAsset probe test (write a minimal PNG fixture via bytes to a temp project, import, assert metadata) to `imageInfo.test.ts` or the existing asset command test file — follow where existing importAsset tests live (`grep -rn "importAsset" packages/core/test/`).
- [ ] **Step 5: Verify** — `npx vitest run packages/core/test/imageInfo.test.ts` then the full core suite `npx vitest run packages/core` and `npm run typecheck`.
- [ ] **Step 6: Commit** — `git commit -m "feat: probe image dimensions on import"`.

---

### Task 2: Spritesheet frames — schema, accessors, `sliceSpritesheet`

**Files:**
- Modify: `packages/core/src/schema/project.ts` (add `SpritesheetFrameSchema` + `SpritesheetFrame` export near `AnimationDataSchema` ~line 81)
- Create: `packages/core/src/assets/sheetFrames.ts`
- Modify: `packages/core/src/commands/assetCommands.ts` (new command), `packages/core/src/commands/registry.ts` (register it; see lines 18-73), `packages/core/src/index.ts` (exports)
- Test: `packages/core/test/spritesheet.test.ts`

**Interfaces:**
- Consumes: `probeImage` (Task 1).
- Produces (later tasks rely on these EXACT names):
  - `SpritesheetFrameSchema` / `type SpritesheetFrame = { name: string; x: number; y: number; width: number; height: number }` (zod: name min 1; x,y int ≥ 0; width,height int > 0).
  - `getSheetFrames(asset: Asset): SpritesheetFrame[]` — parses `asset.metadata.frames` with `z.array(SpritesheetFrameSchema).safeParse`; returns `[]` on absent/invalid.
  - `findSheetFrame(asset: Asset, name: string): SpritesheetFrame | null`.
  - Command `sliceSpritesheet` params: `{ asset: string, frameWidth: int>0, frameHeight: int>0, margin: int≥0 = 0, spacing: int≥0 = 0, namePrefix?: string }`. Result data: `{ assetId, frameCount, columns, rows, frames: string[], warning?: string }`.

- [ ] **Step 1: Failing tests** in `packages/core/test/spritesheet.test.ts` (follow the harness style of an existing command test — temp project via the same helper other asset tests use):
  - Slice a 130×64 PNG (bytes built as in Task 1's fixture) imported as a sprite with frameWidth 32, frameHeight 32: expect columns 4, rows 2, frameCount 8, names `<prefix>_0`..`_7`, a `warning` mentioning unused pixels (130 = 4×32 + 2 leftover), and `metadata.grid = {frameWidth: 32, frameHeight: 32, margin: 0, spacing: 0}`.
  - Frame rects row-major: frame 5 (row 1, col 1) has `{x: 32, y: 32}`.
  - margin 1, spacing 2 on a 69×35 sheet with 16×16 frames: columns = floor((69-2+2)/(16+2)) = 3, rows = 2; frame 4 (row 1, col 1) at `{x: 1+18, y: 1+18}`.
  - Default `namePrefix` = slug of asset name; explicit prefix respected.
  - Re-slicing replaces frames (slice twice with different sizes; old frames gone).
  - Errors: asset not found → NOT_FOUND; asset of type `audio` → INVALID_INPUT; frame larger than image (frameWidth 999) → INVALID_INPUT; dimensionless SVG asset → INVALID_INPUT.
  - `getSheetFrames` returns [] for an unsliced asset and for corrupt `metadata.frames = "nope"`; `findSheetFrame` finds by exact name, null otherwise.
- [ ] **Step 2: Verify failure** — `npx vitest run packages/core/test/spritesheet.test.ts`.
- [ ] **Step 3: Implement.** Schema in `project.ts`; accessors:

```ts
// packages/core/src/assets/sheetFrames.ts
import { z } from 'zod';
import { SpritesheetFrameSchema, type Asset, type SpritesheetFrame } from '../schema/project.js';

const FramesArray = z.array(SpritesheetFrameSchema);

/** The only sanctioned reader of asset.metadata.frames. [] when absent or invalid. */
export function getSheetFrames(asset: Asset): SpritesheetFrame[] {
  const parsed = FramesArray.safeParse(asset.metadata.frames);
  return parsed.success ? parsed.data : [];
}

export function findSheetFrame(asset: Asset, name: string): SpritesheetFrame | null {
  return getSheetFrames(asset).find((f) => f.name === name) ?? null;
}
```

Command in `assetCommands.ts` (mirror the defineCommand style of the file; permission `asset-edit`, mutates true): resolve asset via `ctx.store.getAsset` (NOT_FOUND otherwise); require type sprite/tile (INVALID_INPUT); read bytes via `ctx.fs.readFileBinary(joinPath(ctx.store.root, asset.path))`; `probeImage` → null means INVALID_INPUT with message naming the file and that its dimensions could not be determined (mention dimensionless SVG). Grid: `columns = Math.floor((imgW - 2*margin + spacing) / (frameWidth + spacing))`, same for rows; if `columns < 1 || rows < 1` → INVALID_INPUT stating the frame size doesn't fit. Frames row-major, `x = margin + col*(frameWidth+spacing)`, `y = margin + row*(frameHeight+spacing)`, names `${prefix}_${index}` where `prefix = params.namePrefix ?? slugify(asset.name)`. Write `asset.metadata.frames` (plain objects parsed through `SpritesheetFrameSchema`), `asset.metadata.grid = {frameWidth, frameHeight, margin, spacing}`, and backfill `width/height/format` from the probe. Compute leftover per axis (`imgW - (2*margin + columns*frameWidth + (columns-1)*spacing)`); when either leftover > 0, set `warning` like `` `sheet is ${imgW}x${imgH}; ${leftoverX}px unused on the right, ${leftoverY}px on the bottom` `` (include only the nonzero axis phrases). Call `ctx.changed({kind: 'asset', id, name, action: 'modified'})` and `ctx.suggest('createAnimationFromSheet --sheet <name> --frames ...')`. Register in `registry.ts`; export accessors from core index.
- [ ] **Step 4: Verify** — spritesheet test file, then `npx vitest run packages/core` and `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat: sliceSpritesheet command with typed frame metadata"`.

---

### Task 3: `createAnimationFromSheet` + validation warnings

**Files:**
- Modify: `packages/core/src/commands/assetCommands.ts`, `packages/core/src/commands/registry.ts`
- Modify: `packages/core/src/validate.ts` (follow the Wave B pattern of `COLLIDER_COLLIDES_WITH_NOTHING` — grep it for the warning shape and the cross-scene pre-pass)
- Test: `packages/core/test/animationFromSheet.test.ts` (+ extend the existing validate test file where the collider warnings are tested)

**Interfaces:**
- Consumes: `getSheetFrames`/`findSheetFrame` (Task 2).
- Produces: command `createAnimationFromSheet` params `{ name: string, sheet: string, frames: string[] (min 1), frameDuration: number>0 = 0.15, loop: boolean = true }` → writes a standard `.anim.json` whose `frames` entries are `"<sheetAssetId>#<frameName>"`; result `{ asset, frames: string[] }` like `createAnimationAsset`. Frame-ref convention for ALL later tasks: `<assetId>#<frameName>`, split on the FIRST `#`. Validation codes `FRAME_NOT_FOUND` and `ANIMATION_FRAME_NOT_FOUND` (warnings, not errors).

- [ ] **Step 1: Failing tests**: command happy path (slice a sheet, create animation from 3 frame names, read back the written `.anim.json` — entries are `ast_xxx#name` using the sheet's id even when `sheet` was passed by name); missing frame names → INVALID_INPUT listing them; unsliced sheet → INVALID_INPUT; metadata carries `{frameCount, frameDuration, loop, sheet: <assetId>}`. Validation: a SpriteRenderer with `frame: 'nope'` on a sliced sheet → warning FRAME_NOT_FOUND (and no warning when the frame exists or when `frame` is null); an `.anim.json` with a `#` ref to a missing frame → ANIMATION_FRAME_NOT_FOUND. NOTE: `SpriteRenderer.frame` does not exist until Task 4 — in this task, write the validate code reading `components.SpriteRenderer?.frame` defensively via the component's parsed type ONLY IF Task 4 already landed; it has NOT. Therefore: implement ONLY the ANIMATION_FRAME_NOT_FOUND validation here, and leave FRAME_NOT_FOUND to Task 4 (which owns the schema field). Tests here cover the animation warning only.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Command mirrors `createAnimationAsset` (same id quirk `generateId('anm').replace(/^anm/, 'ast')`, same CONFLICT-on-existing-file, `AnimationDataSchema.parse` of `{frames: refs, frameDuration, loop}`). Resolve sheet (NOT_FOUND), require sliced (`getSheetFrames(sheet).length > 0` else INVALID_INPUT "sheet has no frames — run sliceSpritesheet first"), validate every requested frame name via `findSheetFrame` collecting misses → INVALID_INPUT `Frames not found on sheet "<name>": a, b`. Validation pass in `validate.ts`: for each animation asset, read its `.anim.json` (the validate pass already has fs access — follow how existing validation reads files; if it doesn't read files today, load via the store's animation loading path used by `inspectAssets`/runtime — grep `anim.json` in packages/core), for each entry containing `#`: resolve sheet asset by id and frame by name; unresolved → warning `ANIMATION_FRAME_NOT_FOUND` naming the animation asset and the bad ref. Plain (no-`#`) entries keep whatever validation exists today.
- [ ] **Step 4: Verify** — new test file + core suite + `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat: createAnimationFromSheet with sheet frame refs"`.

---

### Task 4: SpriteRenderer.frame + animator sheet refs (headless)

**Files:**
- Modify: `packages/core/src/schema/components.ts` (SpriteRendererSchema lines 28-41 + COMPONENT_DOCS entry)
- Modify: `packages/runtime/src/animator.ts` (return type), `packages/runtime/src/runtime.ts` (`stepAnimators`, grep it — currently writes `sprite.assetId` around line 664)
- Modify: `packages/core/src/validate.ts` (+FRAME_NOT_FOUND from Task 3's note)
- Test: `packages/runtime/test/spriteFrame.test.ts` + existing animator test file (grep `stepAnimator` in packages/runtime/test)

**Interfaces:**
- Consumes: frame-ref convention `<assetId>#<frameName>` (Task 3), `findSheetFrame` (Task 2).
- Produces: `SpriteRendererSchema` gains `frame: z.string().nullable().default(null)`. `stepAnimator` return type changes from `string | null` to `AnimatorFrame | null` where `export interface AnimatorFrame { assetId: string; frame: string | null }` (exported from animator.ts). Runtime writes BOTH `sprite.assetId` and `sprite.frame` every animator step (plain refs write `frame: null`). Task 5 renders `frame`; Task 12 edits it.

- [ ] **Step 1: Failing tests**: `stepAnimator` with frames `['ast_a#walk_0', 'ast_a#walk_1']` returns `{assetId: 'ast_a', frame: 'walk_0'}` then advances; plain ref `['ast_b']` returns `{assetId: 'ast_b', frame: null}`. Runtime integration (build a store with a sliced sheet + `createAnimationFromSheet` + entity with SpriteRenderer+SpriteAnimator, run frames headlessly the way existing animator runtime tests do): SpriteRenderer.frame cycles through frame names; switching the animator to a plain (non-sheet) animation resets `frame` to null. Validation: SpriteRenderer with `frame` set but asset has no such frame → FRAME_NOT_FOUND warning; `frame: null` → no warning; frame exists → no warning.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.** Schema field + COMPONENT_DOCS text ("frame: name of a sliced sheet frame to draw (null = whole image)"). animator.ts: parse the current entry once at return: `const ref = asset.frames[state.frame]; const i = ref.indexOf('#'); return i === -1 ? { assetId: ref, frame: null } : { assetId: ref.slice(0, i), frame: ref.slice(i + 1) };` (doc comment updated; keep the pure-function contract). runtime.ts `stepAnimators`: write `sprite.assetId = r.assetId; sprite.frame = r.frame;` (both, always). validate.ts: FRAME_NOT_FOUND per Task 3's description — SpriteRenderer with non-null `frame` whose `assetId` asset is missing, unsliced, or lacks that frame name (cross-scene pre-pass like the collider warnings; reuse `findSheetFrame`).
- [ ] **Step 4: Verify** — runtime + core suites, `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat: SpriteRenderer.frame with animator sheet refs"`.

---

### Task 5: Renderer — sub-textures + tint (Chromium-gated)

**Files:**
- Modify: `packages/runtime/src/pixi/index.ts` — `preloadTextures` (~446-498), `buildSpriteRenderable` (~748-777), `spriteSnapshotKey` (~744, 828-847)
- Test: extend the existing Chromium-gated visual test file (grep `HEARTH_BROWSER\|chromium` in packages/runtime/test to find the pattern and its gating env var)

**Interfaces:**
- Consumes: `SpriteRenderer.frame` (Task 4), `findSheetFrame` (Task 2), animation `#` refs (Task 3).
- Produces: rendering behavior only. Contract (prose governs):
  1. `preloadTextures` must strip `#frame` suffixes when collecting animation frame asset ids (split on first `#`, load the sheet id).
  2. New private `frameTextures = new Map<string, Texture>()` keyed `${assetId}#${frameName}`; sub-texture built once from the base texture's `source` with `new Rectangle(f.x, f.y, f.width, f.height)` as the frame.
  3. Textured branch of `buildSpriteRenderable`: when `sprite.frame` non-null, use the sub-texture; unknown frame name / unsliced asset → warn ONCE per `${assetId}#${frame}` key (via the existing onLog warn path) and fall back to the whole texture.
  4. Textured sprites now set `.tint` from `sprite.color` (Pixi accepts `'#rrggbb'` strings or use the file's existing hex→number helper if one exists). Default `#ffffff` = identity. Opacity/alpha behavior unchanged.
  5. `frame` and `color` both participate in `spriteSnapshotKey` so live edits rebuild the node (color is already in the key — verify; add `frame`).
  6. `frameTextures` cleared wherever `textures` is cleared/rebuilt (scene change/destroy — mirror existing lifecycle).
- Chromium tests (follow the existing pixel-assert pattern exactly): (a) two entities showing different frames of the same generated sheet render different pixels at their centers; (b) changing `frame` between renders changes pixels (assert pixels CHANGE across frames — standing rule for visual features); (c) a textured sprite with `color: '#ff0000'` renders differently from `#ffffff`, and `#ffffff` renders identically to the pre-change baseline of the same scene.

- [ ] **Step 1: Write the failing Chromium tests** (they must fail because `frame`/tint are ignored, not because of setup errors — build the sheet with `sliceSpritesheet` on a PNG written from test bytes with two visibly different colored frames).
- [ ] **Step 2: Run the gated suite** the way the existing visual tests document (env var + `npx vitest run <file>`); confirm the new assertions fail.
- [ ] **Step 3: Implement per the contract.**
- [ ] **Step 4: Verify** — gated suite passes; full runtime suite + `npm run typecheck` (ungated tests must not regress).
- [ ] **Step 5: Commit** — `git commit -m "feat: render spritesheet frames and texture tint"`.

---

### Task 6: Music channel — runtime + session (headless)

**Files:**
- Modify: `packages/runtime/src/runtime.ts` (AudioEvent ~85, AudioPlaybackEvent ~92, RuntimeOptions ~107, audio section ~470-521, ctx.audio bindings ~848)
- Modify: `packages/runtime/src/session.ts` (music state ownership; onAudio handler ~223-225; performSwitch ~189)
- Modify: `packages/core/src/schema/components.ts` (AudioSourceSchema lines 110-115 + COMPONENT_DOCS), `packages/core/src/ctxApi.ts` (audio docs ~408-425)
- Test: `packages/runtime/test/music.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 7/8 rely on these exactly):
  - `AudioEvent` gains `music?: boolean` (set `true` only on music play/stop records).
  - `AudioPlaybackEvent` becomes `{ action: 'play' | 'stop' | 'music-volume'; handleId: string; assetId: string; volume: number; loop: boolean; music?: boolean; fadeIn?: number; fadeOut?: number; fade?: number }`.
  - `export interface MusicChannelState { current: { handleId: string; assetId: string } | null; seq: number }` (exported from runtime.ts); `RuntimeOptions` gains `musicChannel?: MusicChannelState`; SceneRuntime creates its own when not provided (standalone use); GameSession creates ONE in its constructor and passes it to every `startScene`.
  - SceneRuntime methods: `playMusic(assetRef: string, opts?: { volume?: number; loop?: boolean; fadeIn?: number }): string | null`; `stopMusic(opts?: { fadeOut?: number }): void`; `setMusicVolume(volume: number, opts?: { fade?: number }): void`.
  - ctx.audio gains `playMusic/stopMusic/setMusicVolume` (JS and Lua ride the same ctx object — verify Lua needs no extra binding beyond the ctx proxy, which is how Wave B's ctx.math worked; nullable return must be JS `null` for NullToNil).

Behavioral contract (prose governs):
- `playMusic`: resolve asset (id or name); unknown → warn `audio.playMusic: asset not found: <ref>` + return null. If `state.current` exists: record a stop for it FIRST (music stop event, `fadeOut` = the new call's `fadeIn ?? 0`). New handle `mus_${++state.seq}`; set `state.current`; record play with `music: true`, `volume` (default 1, clamp 0..1), `loop` (default true), `fadeIn` (default 0). Return handle.
- `stopMusic`: no current → no-op (no warn). Else record music stop with `fadeOut` (default 0); clear `state.current`.
- `setMusicVolume`: no current → no-op. Else fire `options.onAudio` DIRECTLY with `{action: 'music-volume', handleId, assetId, volume: clamped, loop: false, music: true, fade: opts.fade ?? 0}` — do NOT push to `audioEvents`.
- Music never enters `activePlaybacks`; `stopAllAudio`/`stopAudio` never touch it; `destroy()` leaves the shared state alone (session owns it).
- AudioSource autoplay (~runtime.ts:393): when `source.music` is true call `this.playMusic(source.assetId, { volume: source.volume, loop: source.loop })` instead of `playAudio`.
- session.ts: `onAudio` handler pushes to `session.audioEvents` ONLY when `e.action !== 'music-volume'`, and copies the `music` flag: `{frame, assetId: e.assetId, action: e.action, ...(e.music ? {music: true} : {})}`. `performSwitch` keeps calling `old.stopAllAudio()` — music untouched because it lives in the shared channel.
- AudioSourceSchema gains `music: z.boolean().default(false)`; COMPONENT_DOCS updated. ctxApi.ts gains three doc entries (path `audio.playMusic` etc., signatures matching the methods, one-line descriptions + js/lua examples in the file's existing style).

- [ ] **Step 1: Failing tests** in `packages/runtime/test/music.test.ts` (headless, follow existing runtime/session test harness): playMusic returns `mus_1` and records `{action:'play', music:true}`; second playMusic records stop-for-first (with `music:true`) then play `mus_2`; stopMusic records stop and subsequent stopMusic is a no-op (no new events, no warn log); setMusicVolume fires onAudio `music-volume` but adds NOTHING to audioEvents (runtime and session); unknown asset → null + warn log; AudioSource `{music:true, autoplay:true, volume:0.5, loop:true}` records a music play on frame 0 with volume 0.5; **scene-switch test**: playMusic in scene A, `ctx.scenes.load` to scene B, step through the switch — music play/stop history shows NO stop from the switch, and `stopMusic` called in scene B DOES record the stop for `mus_1` (shared channel survived); `stopAllAudio` leaves music playing; ctx exposure: a script calling `ctx.audio.playMusic('track')` works (both a JS script test and, if the existing suite has a cheap Lua-script test pattern, a Lua call `ctx.audio.playMusic("track")`).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement per the contract.**
- [ ] **Step 4: Verify** — music tests + full runtime suite + core suite (schema change) + `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat: session-scoped music channel with fades"`.

---

### Task 7: Music streaming — web host

**Files:**
- Modify: `packages/runtime/src/pixi/audio.ts` (WebAudioPlayer), `packages/runtime/src/pixi/index.ts` (onAudio wiring ~218-240)
- Test: extend the existing audio unit test file (grep `WebAudioPlayer\|playsToStartOnResume` in packages/runtime/test)

**Interfaces:**
- Consumes: `AudioPlaybackEvent` shape from Task 6.
- Produces: `WebAudioPlayer` methods `playMusic(handleId: string, assetId: string, opts: { volume: number; loop: boolean; fadeIn: number }): void`, `stopMusic(opts: { fadeOut: number }): void`, `setMusicVolume(volume: number, fade: number): void`.

Behavioral contract (prose governs):
- Music plays through `new Audio(url)` (`preload='auto'`, `crossOrigin='anonymous'`, `loop` from opts, element created via `document.createElement('audio')` fallback-free — guard `typeof Audio === 'function'`; when unavailable (headless), all three methods are silent no-ops) wrapped in `ctx.createMediaElementSource(el)` → a dedicated music `GainNode` → master. NO `decodeAudioData` on the music path.
- `playMusic` replaces any current music: current fades out over the new call's `fadeIn` seconds (linearRamp to 0, then pause + disconnect via a timer; immediate when 0) while the new track's gain ramps 0→volume over `fadeIn` (or starts at volume when 0). `el.play()` rejection → warn via `onWarn`, cleanup.
- Suspended context: store ONE pending music request (latest wins) and start it in `flushPending` — music is never dropped as stale (matches the loop rule in `playsToStartOnResume`; the element route also can't autoplay pre-gesture, which is exactly what the unlock queue handles).
- `stopMusic({fadeOut})`: ramp to 0 over fadeOut then pause/disconnect (immediate when 0); clears pending music if queued. `setMusicVolume(v, fade)`: linearRamp the music gain (set directly when fade 0). `stopAll`/`destroy` also kill music (element paused, src cleared).
- Fades use `gain.linearRampToValueAtTime(target, ctx.currentTime + seconds)` with `setValueAtTime(current, ctx.currentTime)` first (presentation-side wall-clock — fine, never simulation).
- pixi/index.ts wiring: in the existing `onAudio` handler, route `e.music && e.action === 'play'` → `audio.playMusic(e.handleId, e.assetId, {volume: e.volume, loop: e.loop, fadeIn: e.fadeIn ?? 0})`; `e.music && e.action === 'stop'` → `audio.stopMusic({fadeOut: e.fadeOut ?? 0})`; `e.action === 'music-volume'` → `audio.setMusicVolume(e.volume, e.fade ?? 0)`; non-music play/stop unchanged.
- Unit tests run headless with stubs (the existing audio test file already tests pure parts; add: `playsToStartOnResume` unchanged; music methods no-op without `Audio`; and if the existing file stubs AudioContext, extend the stub with `createMediaElementSource` and assert replace/fade call sequences — scale to what the existing harness supports; the pure decision logic (pending-music latest-wins) should be extracted as a small exported pure function if needed for testing).

- [ ] **Step 1: Failing tests** per contract (whatever the existing stub harness supports; at minimum: no-op without Audio; pending-music latest-wins pure logic; wiring routes music events to the right methods — the wiring can be tested by constructing the handler function if exported, else covered by the Chromium smoke in Step 4).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — runtime suite + `npm run typecheck`; if the Chromium-gated harness supports it cheaply, add a gated smoke: mount a scene whose AudioSource has `music: true` and assert a `<audio>` element/MediaElementSource was created (skip if the harness fights it — note the decision in the report).
- [ ] **Step 5: Commit** — `git commit -m "feat: stream music through media elements in the web host"`.

---

### Task 8: `assertAudioCount` playtest assertion

**Files:**
- Modify: `packages/core/src/schema/project.ts` (PlaytestStepUnionSchema ~92-148 + superRefine ~150-173)
- Modify: `packages/playtest/src/index.ts` (executor — mirror the `assertEventCount` case; grep it)
- Test: extend the existing playtest test file that covers `assertEventCount` (grep `assertEventCount` in packages/playtest/test and packages/core/test)

**Interfaces:**
- Consumes: `AudioEvent.music` (Task 6), session `audioEvents`.
- Produces: step schema `{ type: 'assertAudioCount', asset?: string, action?: 'play' | 'stop', music?: boolean, equals?: int≥0, min?: int≥0, max?: int≥0 }`; superRefine requires at least one of equals/min/max (same message style as assertEventCount's). Executor counts `session.audioEvents` where: `asset` provided → resolve via `store.getAsset(a.asset)`; unresolvable → assertion FAILS with message `assertAudioCount: asset not found: <ref>`; else match `ev.assetId === resolved.id`. `action` provided → `ev.action === a.action`. `music` provided → `Boolean(ev.music) === a.music`. Bounds checked exactly like assertEventCount (equals/min/max, same failure message format naming actual vs expected).

- [ ] **Step 1: Failing tests**: schema accepts the step and rejects a bound-less one (superRefine); executor: a playtest against a project whose script plays SFX twice and music once — `{music: true, action: 'play', equals: 1}` passes, `{action: 'play', equals: 3}` passes (2 sfx + 1 music), `{music: false, action: 'play', equals: 2}` passes, `{asset: '<name>', action: 'play', min: 1}` passes by name, `{asset: 'nope', min: 1}` fails with the not-found message, `{action: 'stop', equals: 5}` fails with actual-vs-expected.
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** (schema + executor; follow assertEventCount verbatim in structure).
- [ ] **Step 4: Verify** — playtest + core suites, `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat: assertAudioCount playtest assertion"`.

---

### Task 9: Font assets load everywhere

**Files:**
- Modify: `packages/runtime/src/pixi/index.ts` (mount/preload phase)
- Test: extend the Chromium-gated test file (same harness as Task 5)

**Interfaces:**
- Consumes: `resolveAssetUrl` (existing), font-type assets (existing; `woff` ext added in Task 1).
- Produces: rendering behavior only. Contract: during mount, alongside `preloadTextures`, run `loadFonts()`: for every asset with `type === 'font'`, `const face = new FontFace(asset.name, \`url(${opts.resolveAssetUrl(asset)})\`)`; `await face.load()`; `document.fonts.add(face)`. Guard `typeof FontFace === 'undefined' || typeof document === 'undefined'` → skip silently. Per-font load failure → warn via onLog (`font: failed to load asset <name>: <msg>`) and continue. Fonts awaited BEFORE the first render (same await barrier as textures). Family name is EXACTLY the asset name.

- [ ] **Step 1: Failing Chromium test**: build a project importing `packages/examples/fixtures/fonts/press-start-2p.ttf` (already committed — reference it by path from the repo root), a Text entity with `fontFamily` = the asset name; after mount assert `document.fonts.check('16px "<asset name>"')` is true AND the rendered pixels differ from the same scene with `fontFamily: 'monospace'` (pixels-change rule). Also: a project with a font asset pointing at a bogus file mounts without throwing and logs a warning.
- [ ] **Step 2: Verify failure** (font check false today).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — gated + full runtime suites, `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat: load font assets via FontFace at mount"`.

---

### Task 10: Export bundle metadata + CLI + MCP wiring

**Files:**
- Modify: `packages/core/src/commands/exportCommands.ts` (`WebExportBundle` ~16-22; bundle assembly ~230-232)
- Modify: `packages/cli/src/program.ts` (new leaves under the existing command tree — read the file first and follow its group/flag conventions exactly; Wave B's `inspect path` leaf is the model)
- Modify: `packages/mcp-server/src/tools.ts` (two ToolSpecs; mirror `inspect_path`'s structure) + `packages/mcp-server/README.md` tool table row (two rows)
- Test: extend existing CLI test file (grep how `inspect path` is tested) + existing tools test if one exists; an export test asserting bundle assets carry `metadata`.

**Interfaces:**
- Consumes: `sliceSpritesheet`, `createAnimationFromSheet` (Tasks 2-3).
- Produces:
  - `WebExportBundle` asset entries gain `metadata: Record<string, unknown>` (copied from the asset; both multi-file and single-file paths).
  - CLI: `hearth asset slice <asset> --frame-size <WxH> [--margin N] [--spacing N] [--prefix NAME]` and `hearth asset anim-from-sheet <name> --sheet <asset> --frames a,b,c [--duration SECONDS] [--no-loop]` — IF `program.ts` has no `asset` group, create it following how `inspect` groups its leaves; if existing asset commands are exposed under different verbs (e.g. `hearth create sprite`), match THAT convention instead and note the final names in the report. `--frame-size` parses `32x32` (integers, `x` separator, INVALID usage error otherwise); `--frames` comma-splits.
  - MCP tools `slice_spritesheet` and `create_animation_from_sheet` mapping 1:1 onto the command params.
- Player: verify (test, not code) that a single-file export of a project with a sliced sheet + `frame` renders — if the player reconstructs assets from the bundle, metadata now flows; the Chromium export test pattern from Wave A/B applies if one exists, else assert the bundle JSON contains `frames` and the player's store carries it (grep how the player builds its store in `packages/runtime/src/player/index.ts` — if it drops metadata, fix it there too; that fix is IN SCOPE for this task).

- [ ] **Step 1: Failing tests** (bundle metadata assertion; CLI leaf parse/dispatch tests in the existing style; MCP tool registration test in the existing style).
- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify** — core + cli + mcp-server suites, `npm run typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat: expose slicing over CLI and MCP; bundle asset metadata"`.

---

### Task 11: Editor — slice dialog, previews, multi-file import

**Files:**
- Modify: `apps/editor/src/components/AssetsPanel.tsx`
- Create: `apps/editor/src/components/SliceDialog.tsx` (if the file would otherwise grow unwieldy — AssetsPanel is already ~350 lines; a separate component file is right)
- Test: `apps/editor` test conventions — grep for existing component tests; if none exist for panels, the acceptance is manual-verifiable behavior + typecheck + existing suites green (note it in the report).

**Interfaces:**
- Consumes: `sliceSpritesheet` command (via the existing `apiCommand`/command POST path the panel already uses — grep `createSprite` handlers in the panel for the call pattern), `getSheetFrames` re-exported from `@hearth/core`, `fileUrl` helper.
- Produces: UI only.

Contract (impeccable design skill applies — visual hierarchy, spacing, accessibility; match the editor's existing design tokens/classes rather than inventing new ones):
1. **Slice dialog**: a "Slice…" action available on selected sprite/tile assets opens a modal (match the existing create-sprite modal's structure/classes). Fields: Frame width, Frame height (number inputs, min 1), Margin, Spacing (number inputs, min 0), Name prefix (text, placeholder = asset slug). Live preview: the sheet image with the computed grid drawn over it (absolutely-positioned divs or SVG overlay scaled to the displayed image; cells at the exact x/y/w/h the command will produce — reuse the same columns/rows formula, computed client-side from the image's naturalWidth/Height) plus a readout "8 frames (4 × 2)". Invalid values (frame bigger than image) disable confirm and show the reason inline. Already-sliced assets prefill from `metadata.grid`. Confirm calls the command, refreshes the panel, shows errors inline (existing panel error pattern).
2. **Details for sliced sheets**: frame grid (each frame cropped via CSS `background-image` + `background-position: -x -y` at natural scale or scaled-down consistently) with frame names beneath; count badge on the card ("8 frames").
3. **Animation cards**: first-frame thumbnail — resolve the animation's first frame ref; plain ref → that asset's image; `#` ref → cropped cell of the sheet (same CSS crop technique). Fetch the `.anim.json` via the existing `fileUrl` route.
4. **Font cards/details**: load the font via FontFace (family = asset name, url = fileUrl) once per panel mount (cache loaded names in a ref) and render a sample line "Aa Bb 0123 — Hearth" in the details pane styled with that family.
5. **Multi-file import**: verify the drop handler and the Import… picker iterate ALL files (the drop handler code at AssetsPanel.tsx:222-274 — if it already loops, confirm and note; if not, fix). Per-file failures surface individually (e.g. a list of "imported 3, failed 1: name (reason)") rather than aborting the batch.
6. No raw JSON anywhere; `metadata` never rendered as JSON.

- [ ] **Step 1: Read the panel + one existing modal end to end** before writing anything.
- [ ] **Step 2: Implement per contract** (component-test where the harness exists; otherwise rely on typecheck + suites).
- [ ] **Step 3: Verify** — `npm run typecheck`, full `npx vitest run` (editor suites included), and a smoke: `npm run build` for the editor workspace if the repo's standard build passes locally (match how Wave B's editor task verified — check the ledger notes/report conventions).
- [ ] **Step 4: Commit** — `git commit -m "feat: editor spritesheet slicing and asset previews"`.

---

### Task 12: Editor — Inspector frame + font dropdowns

**Files:**
- Modify: `apps/editor/src/components/Inspector.tsx` (grep `StringListField`/`Vec2ListField` wiring from Waves A/B for the field-override pattern)

**Interfaces:**
- Consumes: `SpriteRenderer.frame` (Task 4), `getSheetFrames` from `@hearth/core`, font assets list (panel API the Inspector already has access to — grep how Inspector reads assets for the assetId picker, if it has one).
- Produces: UI only.

Contract (impeccable applies; typed controls, cohesive with existing fields):
1. `SpriteRenderer.frame`: rendered as a select. Options: "(whole image)" (value null) + the assigned asset's frame names (via `getSheetFrames` on the asset resolved from the entity's current `assetId`). Only shown when the assigned asset HAS frames; hidden otherwise (a text field for `frame` must never appear).
2. `Text.fontFamily`: select with three groups — project font assets (by name), generic families (`monospace`, `sans-serif`, `serif`, `cursive`, `fantasy`), and a "Custom…" option that reveals the plain text field (preserving arbitrary values already set).
3. `AudioSource.music`: confirm the boolean renders with the standard toggle (no work expected — verify and note).
4. All three write through the existing `setComponentProperty` path.

- [ ] **Step 1: Read Inspector's field-override wiring**, implement per contract.
- [ ] **Step 2: Verify** — `npm run typecheck` + full suite.
- [ ] **Step 3: Commit** — `git commit -m "feat: inspector frame and font pickers"`.

---

### Task 13: Sky Courier example + fixture generators

**Files:**
- Create: `packages/examples/pixelart.mjs` (PNG + WAV generators)
- Modify: `packages/examples/generate.mjs` (add `generateSkyCourier()`; wire into the main run list; probe-bake playtests the way generateBouncePatrol does — read that function first)
- Fixtures: `packages/examples/fixtures/fonts/press-start-2p.ttf` + `OFL.txt` are ALREADY COMMITTED — import, don't download.

**Interfaces:**
- Consumes: the full Wave C surface — importAsset (probing), sliceSpritesheet, createAnimationFromSheet, SpriteRenderer.frame, ctx.audio.playMusic / AudioSource.music, assertAudioCount, font asset + Text.fontFamily.
- Produces: `pixelart.mjs` exports `encodePng(width, height, rgba: Uint8Array): Buffer` and `renderChiptuneWav(): Buffer` (both deterministic — same output bytes every run; no Math.random, no Date).

`encodePng` (complete implementation contract — this is bit-fiddly, transcribe carefully):

```js
// packages/examples/pixelart.mjs
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** Encode an RGBA buffer (w*h*4 bytes) as a PNG. Deterministic. */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
```

`renderChiptuneWav`: 16-bit PCM mono 22050 Hz, ~8s (loopable: end on the same chord it starts). A fixed note table (frequencies for a simple two-voice loop: square-wave melody + triangle bass, e.g. 16 steps of 0.5s), pure math synthesis with a 10ms linear attack/release per note to avoid clicks. WAV header identical in structure to `packages/core/src/assets/sounds.ts`'s `encodeWav` (read it; re-implement locally in the .mjs — do NOT import core internals).

`generateSkyCourier()` — a rooftop parcel-delivery game (unique feel, not another arena):
- Character sheet: 96×16 PNG, six 16×16 frames: 4 walk (leg positions differ per frame) + 2 idle (bob). Draw with a small palette (sky-blue uniform, satchel, skin tone) into an RGBA buffer via helper `px(buf, w, x, y, [r,g,b,a])` loops — hand-authored pixel art in code, deterministic. Write to a temp path (`node:os` tmpdir is fine — the FILE CONTENT is what must be deterministic, the temp path is not persisted), `importAsset` it (assert probed metadata 96×16 in a generator sanity check), `sliceSpritesheet` 16×16 (6 frames), `createAnimationFromSheet` walk (`courier_0..3`, duration 0.12) + idle (`courier_4..5`, duration 0.4).
- Music: write `renderChiptuneWav()` to temp, `importAsset` (type audio, name `rooftop-loop`), scene AudioSource `{assetId, autoplay: true, music: true, volume: 0.6, loop: true}` on a Music entity.
- Font: `importAsset` the committed `press-start-2p.ttf` fixture (path relative to the generator file via `new URL('./fixtures/fonts/press-start-2p.ttf', import.meta.url)`); Score/title Text components use `fontFamily: 'press-start-2p'` (the asset name — set `name: 'press-start-2p'` explicitly at import).
- Gameplay (keep mechanics within one screen, all-Lua like Bounce Patrol — read generateBouncePatrol for the scripting/idiom baseline): rooftop platforms (tilemap or static colliders), the courier (PhysicsBody + input left/right/jump, SpriteAnimator switching walk/idle by horizontal speed via `ctx.animate`), 3 parcels (trigger colliders; on pickup: `ctx.events.emit('parcel', {left = n})`, sound, destroy), a delivery chute that emits `delivered` when all parcels collected and touched, Score UI (Text + press-start-2p) updated via onEvent. Use the Lua userdata-proxy-safe guard for event payloads (`if data and type(data.left) == "number"` — NEVER `type(data) == "table"`; see docs/scripting.md's proxy note).
- Playtests (**probe-baked**: run the probe the way generateBouncePatrol's comment documents, then hard-code observed values): (1) boot: `assertNoErrors`, `assertAudioCount {music: true, action: 'play', equals: 1}`, assertEntityExists courier; (2) movement+animation: scripted presses; assert position via probed values; `assertProperty` that `SpriteRenderer.frame` equals a probed walk-frame name mid-run is allowed ONLY if the probe shows it stable at that exact frame — otherwise assert via an event or position only; (3) pickup: press-sequence reaching a parcel, `assertEventCount {event: 'parcel', min: 1}`.
- Register in generate.mjs's example list; run the generator; verify `npx vitest run packages/examples` (or however example playtests execute — grep the harness; Bounce Patrol's tests show the pattern) is green; run the generator TWICE and diff the two output trees to prove byte-identical PNG/WAV.

- [ ] **Step 1: Read `generateBouncePatrol` + the examples test harness end to end.**
- [ ] **Step 2: Implement pixelart.mjs; sanity-test encodePng by importing it in a scratch node script and running `probeImage` over the output (must report the right dimensions).**
- [ ] **Step 3: Implement generateSkyCourier; probe-bake playtests; regenerate.**
- [ ] **Step 4: Verify** — examples suite + FULL `npx vitest run` + `npm run typecheck`; double-generation byte-identity check.
- [ ] **Step 5: Commit** — `git commit -m "feat: Sky Courier example with imported binary assets"` (fixtures already committed; include generated example output per the repo's convention for committed examples — check `git status` of the examples output dir against how Bounce Patrol is committed).

---

### Task 14: Version 0.6.0 + docs

**Files:**
- Modify: all 9 `package.json` versions + `HEARTH_VERSION` (packages/core/src/schema/project.ts), CLI `VERSION` (packages/cli/src/program.ts), MCP `SERVER_VERSION` (packages/mcp-server/src/server.ts) → `0.6.0`
- Create: `docs/assets.md`
- Modify: `docs/components.md`, `docs/scripting.md`, `docs/cli.md`, `docs/mcp.md`, `docs/architecture.md`, `docs/roadmap.md`, `packages/mcp-server/README.md` (verify Task 10's rows), root `README.md` if it lists features/examples
- Regenerate all examples (now carrying 0.6.0); rebuild the player bundle the way Wave B's version task did (check the ledger/git history for `hearth-player` build step: `git log --oneline v0.4.0..v0.5.0 -- packages/runtime` and the build scripts).

**Interfaces:** consumes everything; produces the release-ready tree.

Content requirements (accuracy over volume; every claim checked against the code):
- `docs/assets.md`: import (formats, probing, where files land), slicing (grid params, worked example with real CLI commands + JSON output), animations from sheets (`#` ref convention), music (playMusic semantics — single channel, replace + fades, survives scene switches, streaming vs single-file exports caveat), fonts (asset name = family, FontFace timing, editor/live-edit note), `assertAudioCount`, agent walkthrough (CLI + MCP sequence from import to green playtest).
- components.md: SpriteRenderer `frame` + tint note, AudioSource `music`.
- scripting.md: ctx.audio music trio with Lua examples (dot-call).
- architecture.md: asset pipeline section (metadata as typed-frame store, accessor rule, bundle metadata).
- roadmap.md: "Shipped in v0.6.0" section.

- [ ] **Step 1: Docs + version bumps.**
- [ ] **Step 2: Regenerate examples; rebuild player; FULL suite + `npm run typecheck`.**
- [ ] **Step 3: Commit** — `git commit -m "docs: asset pipeline guide; bump to 0.6.0"`.

---

## Self-Review (done at write time)

- **Spec coverage**: §4.1→T1, §4.2→T2-T5 (+T10 bundle), §4.3→T6-T8, §4.4→T9 (+woff in T1), §4.5→T11-T12, §4.6→T13, §4.7→T10+T14. No gaps found.
- **Placeholder scan**: clean — every code step has code or a binding prose contract; "follow existing pattern" always names the exact pattern and where to grep it.
- **Type consistency**: `AnimatorFrame {assetId, frame}` (T4) consumed by T5; `MusicChannelState` (T6) consumed by T7 wiring; `SpritesheetFrame` (T2) consumed by T3/T4/T5/T11/T12; `AudioPlaybackEvent` union (T6) consumed by T7/T8. `getSheetFrames`/`findSheetFrame` names used identically throughout.
