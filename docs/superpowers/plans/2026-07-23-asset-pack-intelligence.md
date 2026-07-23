# Asset Pack Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Hearth agents a shared CLI/MCP pack-inspection workflow, fixed sliced-sheet Tilemap frames, strict Tilemap validation, and skills that make evidence-first asset handling automatic.

**Architecture:** Add one read-only `inspectAssetPack` core command that scans a local pack through `ctx.fs` and returns deterministic metadata and compatibility diagnostics. CLI/MCP remain thin adapters, with optional PNG contact-sheet generation in Node-only `@hearth/playtest`, while the existing Tilemap union gains a browser-safe fixed-frame arm used by core, runtime, editor, export preload, and validation.

**Tech Stack:** TypeScript ESM, Zod, `@xmldom/xmldom`, Commander, MCP SDK, PixiJS, React, Playwright, Vitest, generated Hearth skills/templates/examples.

---

## File Structure

New focused files:

- `packages/core/src/assets/assetPack.ts`: pack report types, bounded directory scan, file classification, TMX/TSX/Tiled-JSON metadata parsing, and compatibility diagnostics.
- `packages/core/src/commands/assetPackCommands.ts`: Zod command input and the read-only `inspectAssetPack` registry command.
- `packages/core/tests/assetPack.test.ts`: synthetic pack fixtures and command behavior.
- `packages/playtest/src/assetPackContactSheet.ts`: deterministic browser-rendered image review sheet.
- `packages/playtest/tests/assetPackContactSheet.test.ts`: pure layout/HTML tests and optional Chromium smoke coverage.
- `packages/core/tests/tilemapFrameSource.test.ts`: schema, mutation, and validation coverage for `{sheet,frame}`.

Existing files change only at their current responsibility:

- registry/export surfaces: `packages/core/src/commands/registry.ts`, `packages/core/src/index.ts`;
- filesystem safety: `packages/core/src/fs.ts`, `packages/core/src/node/index.ts`;
- adapters: `packages/cli/src/program.ts`, `packages/mcp-server/src/tools.ts`, `packages/mcp-server/src/server.ts`;
- Tilemap model/render/editor: `packages/core/src/schema/components.ts`, `packages/core/src/commands/componentCommands.ts`, `packages/runtime/src/pixi/tilemapRender.ts`, `packages/runtime/src/pixi/preload.ts`, `apps/editor/src/tileAutotileRows.ts`, `apps/editor/src/tileAutotileVisual.ts`, `apps/editor/src/components/Inspector.tsx`;
- validation/docs/skills: `packages/core/src/validate.ts`, `packages/core/src/agentFiles.ts`, `skills/hearth-art/SKILL.md`, `skills/hearth-build/SKILL.md`, and current public docs;
- generated artifacts: `packages/core/src/agentSkillContent.ts`, template/example agent files.

## Parallelization

After Task 1 pins `AssetPackReport`, `inspectAssetPack`, and the diagnostic
codes, Tasks 2 and 3 may run in parallel. Task 4 follows Task 3. Task 5 may
baseline-test current skill behavior immediately, but edits wait until Tasks 1
and 3 pin the final command and Tilemap syntax. Task 6 integrates everything.

### Task 1: Core asset-pack report and read-only command

**Files:**

- Modify: `packages/core/package.json`
- Modify: `package-lock.json`
- Modify: `packages/core/src/fs.ts`
- Modify: `packages/core/src/node/index.ts`
- Create: `packages/core/src/assets/assetPack.ts`
- Create: `packages/core/src/commands/assetPackCommands.ts`
- Modify: `packages/core/src/commands/registry.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/tests/assetPack.test.ts`
- Modify: `packages/core/tests/sweepCommands.test.ts`
- Modify: `packages/core/tests/exportDesktop.test.ts`

- [ ] **Step 1: Add failing scan and metadata tests**

Create synthetic packs in `MemoryFileSystem` and execute through
`HearthSession`:

```ts
it('reports deterministic image, provenance, TMX, and TSX facts', async () => {
  const { fs, session } = await setup();
  await fs.mkdir('/packs/dungeon');
  await fs.writeFile('/packs/dungeon/LICENSE.txt', 'CC0 1.0');
  await fs.writeFile('/packs/dungeon/tiles.png', pngHeader(64, 96));
  await fs.writeFile('/packs/dungeon/tiles.tsx', `
    <tileset tilewidth="32" tileheight="32" tilecount="6" columns="2"
      objectalignment="bottom"><tileoffset x="0" y="-32"/>
      <image source="tiles.png" width="64" height="96"/>
      <wangsets><wangset name="Walls" type="mixed"/></wangsets>
    </tileset>`);
  await fs.writeFile('/packs/dungeon/sample.tmx', `
    <map orientation="orthogonal" width="2" height="2"
      tilewidth="32" tileheight="32">
      <tileset firstgid="1" source="tiles.tsx"/>
      <layer name="Floor"><data encoding="csv">1,2,3,4</data></layer>
      <objectgroup name="Collision"/>
    </map>`);

  const result = await session.execute('inspectAssetPack', {
    path: '/packs/dungeon',
    sourceUrl: 'https://example.test/dungeon',
    author: 'Example',
    license: 'CC0-1.0',
  });

  expect(result.success).toBe(true);
  expect(result.changed).toEqual([]);
  expect(result.files).toEqual([]);
  expect(result.data.status).toBe('partial');
  expect(result.data.reviewImages).toEqual(['tiles.png']);
  expect(result.data.maps[0].layers.map((l: any) => l.name)).toEqual(['Floor', 'Collision']);
  expect(result.data.diagnostics.map((d: any) => d.code)).toContain('PACK_OBJECT_LAYER_UNSUPPORTED');
  expect(result.data.diagnostics.map((d: any) => d.code)).toContain('PACK_TILE_OFFSET_UNSUPPORTED');
  expect(result.data.diagnostics.map((d: any) => d.code)).toContain('PACK_TERRAIN_RULES_NOT_IMPORTED');
});
```

Add focused tests for alphabetical report ordering, unknown license, no
metadata, isometric orientation, Tiled JSON, high-bit GID flips, oversized
tiles, malformed XML/JSON, file count/size limits, and a path that is not a
directory.

- [ ] **Step 2: Run the core test and verify RED**

Run:

```bash
npx vitest run packages/core/tests/assetPack.test.ts
```

Expected: FAIL because `inspectAssetPack` is not registered.

- [ ] **Step 3: Add the direct XML dependency**

Run:

```bash
npm install @xmldom/xmldom@^0.8.13 -w @hearth/core
```

Expected: `packages/core/package.json` and `package-lock.json` declare the
browser-safe XML parser directly. Do not rely on the existing transitive copy.

- [ ] **Step 4: Add bounded filesystem safety primitives**

Extend `FsLike` without breaking browser/memory users:

```ts
export interface FsLike {
  // existing methods...
  /** Canonical path when the host can resolve symlinks. */
  realpath?(path: string): Promise<string>;
}
```

Implement `NodeFileSystem.realpath` with `fsp.realpath`. In
`MemoryFileSystem`, return `this.norm(path)`.

- [ ] **Step 5: Implement the report model and scanner**

In `packages/core/src/assets/assetPack.ts`, export:

```ts
export const ASSET_PACK_MAX_FILES = 4096;
export const ASSET_PACK_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const TILED_GID_FLAGS = 0xf0000000;

export type AssetPackStatus = 'compatible' | 'partial' | 'unsupported';
export interface AssetPackDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  evidence: string[];
  suggestion?: string;
}
export interface AssetPackReport {
  root: string;
  status: AssetPackStatus;
  provenance: {
    sourceUrl?: string;
    author?: string;
    license?: string;
    evidenceFiles: string[];
  };
  files: Array<{ path: string; kind: AssetPackFileKind }>;
  images: AssetPackImage[];
  maps: AssetPackMap[];
  diagnostics: AssetPackDiagnostic[];
  reviewImages: string[];
  reviewChecklist: string[];
  contactSheet?: string;
}

export async function inspectAssetPack(
  fs: FsLike,
  params: { path: string; sourceUrl?: string; author?: string; license?: string },
): Promise<AssetPackReport>;
```

Implementation rules:

- walk directories in sorted order and normalize all output paths relative to
  the root;
- use `realpath` when present and skip any entry whose canonical path escapes
  the canonical root;
- classify README/license/image/audio/font/TMX/TSX/JSON/other by basename and
  extension;
- probe images with the existing `probeImage`;
- parse XML with `DOMParser` from `@xmldom/xmldom`, with no entity resolution
  or network access;
- resolve external TSX/JSON tilesets only within the pack root;
- read only the attributes/elements required by the approved report;
- scan CSV and numeric JSON GIDs with `(gid >>> 0) & TILED_GID_FLAGS`;
- derive `status` from diagnostic severities and unsupported orientation;
- always add `PACK_VISUAL_REVIEW_REQUIRED`;
- use the exact stable codes from the design spec.

- [ ] **Step 6: Register the command**

Create `assetPackCommands.ts`:

```ts
export const inspectAssetPackCommand = defineCommand({
  name: 'inspectAssetPack',
  description:
    'Inspect a downloaded asset pack before import: provenance hints, images, Tiled metadata, compatibility diagnostics, and ordered visual-review inputs.',
  permission: 'read-only',
  mutates: false,
  paramsSchema: z.object({
    path: z.string().min(1),
    sourceUrl: z.string().url().optional(),
    author: z.string().min(1).optional(),
    license: z.string().min(1).optional(),
  }).strict(),
  async run(ctx, params) {
    return inspectAssetPack(ctx.fs, params);
  },
});
```

Add it to the inspect section of `COMMANDS`, and export report types and the
pure analyzer from `@hearth/core`.

- [ ] **Step 7: Update exact registry count assertions**

Change the two tests that explicitly pin 78 commands to 79 and assert
`inspectAssetPack` is present and read-only.

- [ ] **Step 8: Run focused tests and typecheck**

Run:

```bash
npx vitest run packages/core/tests/assetPack.test.ts packages/core/tests/sweepCommands.test.ts packages/core/tests/exportDesktop.test.ts
npm run typecheck -w @hearth/core
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/core/package.json package-lock.json packages/core/src/fs.ts \
  packages/core/src/node/index.ts packages/core/src/assets/assetPack.ts \
  packages/core/src/commands/assetPackCommands.ts \
  packages/core/src/commands/registry.ts packages/core/src/index.ts \
  packages/core/tests/assetPack.test.ts \
  packages/core/tests/sweepCommands.test.ts \
  packages/core/tests/exportDesktop.test.ts
git commit -m "Add asset pack inspection command"
```

### Task 2: CLI, MCP, and visual contact sheet

**Files:**

- Create: `packages/playtest/src/assetPackContactSheet.ts`
- Modify: `packages/playtest/src/index.ts`
- Create: `packages/playtest/tests/assetPackContactSheet.test.ts`
- Modify: `packages/cli/src/program.ts`
- Modify: `packages/cli/tests/cli.test.ts`
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Modify: `packages/mcp-server/tests/server.test.ts`
- Modify: `packages/mcp-server/tests/export.test.ts`

- [ ] **Step 1: Write failing pure contact-sheet tests**

Pin deterministic ordering and safe HTML:

```ts
it('builds a labeled nearest-neighbor review grid', () => {
  const html = buildAssetPackContactSheetHtml('/packs/demo', [
    { path: 'characters/hero.png', width: 32, height: 48 },
    { path: 'tiles.png', width: 256, height: 256 },
  ]);
  expect(html).toContain('image-rendering: pixelated');
  expect(html.indexOf('characters/hero.png')).toBeLessThan(html.indexOf('tiles.png'));
  expect(html).toContain('32×48');
  expect(html).not.toContain('<script src=');
});
```

Also reject unsafe output paths and cap image count/sheet dimensions.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run packages/playtest/tests/assetPackContactSheet.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the Node-only helper**

Export:

```ts
export interface AssetPackContactSheetOptions {
  root: string;
  images: Array<{ path: string; width?: number; height?: number }>;
  projectRoot: string;
  outPath: string;
}

export function buildAssetPackContactSheetHtml(
  root: string,
  images: Array<{ path: string; width?: number; height?: number }>,
): string;

export async function captureAssetPackContactSheet(
  opts: AssetPackContactSheetOptions,
): Promise<{ path: string; images: number; cols: number; rows: number }>;
```

Generate a temporary HTML grid with file-URL images, escaped labels, native
dimensions, checkerboard backgrounds, and `image-rendering: pixelated`.
Launch Chromium using the same fallback order and missing-browser error
contract as `screenshot.ts`, wait for all images to complete, then screenshot
the grid element. Require a project-relative `outPath` through `isSafeOut`.
Clean the temporary HTML in `finally`.

- [ ] **Step 4: Add the CLI command**

Under `inspect`:

```ts
inspect
  .command('asset-pack <path>')
  .description('inspect a downloaded asset pack before importing or placing it')
  .option('--source-url <url>')
  .option('--author <name>')
  .option('--license <id>')
  .option('--contact-sheet <path>', 'project-relative PNG review sheet');
```

Execute `inspectAssetPack`. If successful and `--contact-sheet` is present,
call `captureAssetPackContactSheet`, add its absolute output path to
`data.contactSheet` and `result.files`, then emit the normal envelope.

- [ ] **Step 5: Add the MCP tool and adapter post-step**

Add `inspect_asset_pack` to `TOOL_SPECS` with `read-only` permission and:

```ts
inputShape: {
  path: z.string().min(1),
  sourceUrl: z.string().url().optional(),
  author: z.string().min(1).optional(),
  license: z.string().min(1).optional(),
  contactSheet: z.string().optional(),
}
```

In `server.ts`, special-case this tool before generic dispatch, just as
`export_web` handles adapter-only `zip`: strip `contactSheet`, execute the core
command, then attach the generated file or add a `CONTACT_SHEET_FAILED`
warning without converting a successful inspection into a failed command.

- [ ] **Step 6: Add CLI/MCP parity tests**

The CLI test creates a pack beside a real temporary project and asserts:

```ts
expect(envelope.command).toBe('inspectAssetPack');
expect(envelope.data.reviewImages).toEqual(['tiles.png']);
expect(envelope.changed).toEqual([]);
```

The MCP test asserts the same report and that read-only permission is enough.
Update `TOOL_SPECS.length` from 77 to 78, with screenshot/capture/instructions
still outside that count.

- [ ] **Step 7: Run focused tests**

```bash
npx vitest run packages/playtest/tests/assetPackContactSheet.test.ts \
  packages/cli/tests/cli.test.ts \
  packages/mcp-server/tests/server.test.ts \
  packages/mcp-server/tests/export.test.ts
npm run typecheck -w @hearth/playtest
npm run typecheck -w @hearth/cli
npm run typecheck -w @hearth/mcp-server
```

Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add packages/playtest/src/assetPackContactSheet.ts \
  packages/playtest/src/index.ts \
  packages/playtest/tests/assetPackContactSheet.test.ts \
  packages/cli/src/program.ts packages/cli/tests/cli.test.ts \
  packages/mcp-server/src/tools.ts packages/mcp-server/src/server.ts \
  packages/mcp-server/tests/server.test.ts \
  packages/mcp-server/tests/export.test.ts
git commit -m "Expose asset pack inspection to agents"
```

### Task 3: Fixed sliced-sheet Tilemap frames

**Files:**

- Modify: `packages/core/src/schema/components.ts`
- Modify: `packages/core/src/commands/componentCommands.ts`
- Create: `packages/core/tests/tilemapFrameSource.test.ts`
- Modify: `packages/runtime/src/pixi/tilemapRender.ts`
- Modify: `packages/runtime/src/pixi/preload.ts`
- Modify: `packages/runtime/tests/pixi-tilemapRender.test.ts`
- Modify: `packages/runtime/tests/pixi-preload.test.ts`
- Modify: `apps/editor/src/tileAutotileRows.ts`
- Modify: `apps/editor/src/tileAutotileVisual.ts`
- Modify: `apps/editor/src/components/Inspector.tsx`
- Modify: `apps/editor/tests/tileAutotileRows.test.ts`
- Modify: `apps/editor/tests/tileAutotileVisual.test.ts`

- [ ] **Step 1: Write failing schema/mutation tests**

```ts
it('accepts a fixed sliced-sheet frame and allows structured property writes', async () => {
  const source = { sheet: 'ast_sheet', frame: 'floor_7' };
  expect(TileAssetSchema.parse(source)).toEqual(source);
  const result = await session.execute('setComponentProperty', {
    scene: 'Main',
    entity: 'Ground',
    property: 'Tilemap.tileAssets.G',
    value: source,
  });
  expect(result.success).toBe(true);
});

it('still rejects unchecked autotile object writes', async () => {
  const result = await session.execute('setComponentProperty', {
    scene: 'Main',
    entity: 'Ground',
    property: 'Tilemap.tileAssets.G',
    value: { sheet: 'ast_sheet', template: 'blob47' },
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run packages/core/tests/tilemapFrameSource.test.ts
```

Expected: fixed-frame schema parse fails.

- [ ] **Step 3: Extend the TileAsset union**

Add:

```ts
export const TileFrameSourceSchema = z.object({
  sheet: z.string(),
  frame: z.string().min(1),
}).strict();
export type TileFrameSource = z.infer<typeof TileFrameSourceSchema>;

export const TileAssetSchema = z.union([
  z.string(),
  TileFrameSourceSchema,
  AutotileRuleSchema,
]);

export function isTileFrameSource(value: TileAsset): value is TileFrameSource {
  return typeof value === 'object' && value !== null && 'frame' in value;
}
```

Change `assertNotAutotileWrite` so it rejects only objects carrying
`template: "blob47"`; fixed-frame writes go through the normal full-component
schema validation.

- [ ] **Step 4: Add runtime rendering and preload tests**

```ts
it('resolves a fixed frame without computing a neighbor mask', () => {
  const deps = makeDeps({ ast_sheet: BASE_TEXTURE });
  buildTilemapContainer(tilemap({
    grid: ['G'],
    tileAssets: { G: { sheet: 'ast_sheet', frame: 'floor_7' } },
  }), deps);
  expect(deps.calls).toEqual([{ assetId: 'ast_sheet', frame: 'floor_7' }]);
});
```

Pin preload collection of `sheet` for fixed and autotile object arms.

- [ ] **Step 5: Implement runtime resolution**

In `tilemapRender.ts`:

```ts
if (typeof tile === 'string') {
  texture = deps.getTexture(tile);
} else if (isTileFrameSource(tile)) {
  const base = deps.getTexture(tile.sheet);
  if (base) texture = deps.resolveFrameTexture(tile.sheet, tile.frame, base);
} else if (tile) {
  // existing blob47 path
}
```

Update preload types/comments to include both object arms.

- [ ] **Step 6: Add editor data/render tests**

Pin `isTileFrameSource`, three distinct modes, and exact fixed-frame crop
selection in `resolveTileVisual`.

- [ ] **Step 7: Implement editor mode support**

Use the core `TileAsset` and type guards instead of local duplicate unions.
The row editor gets three modes:

- `Sprite`: plain image asset id;
- `Frame`: sliced sheet plus named frame select;
- `Autotile`: existing sheet/template/mapping controls.

`writeChar` sends `Frame` values through `setComponentProperty`, while
`Autotile` still uses `setTileAutotile`.

- [ ] **Step 8: Run focused tests and typechecks**

```bash
npx vitest run packages/core/tests/tilemapFrameSource.test.ts \
  packages/runtime/tests/pixi-tilemapRender.test.ts \
  packages/runtime/tests/pixi-preload.test.ts \
  apps/editor/tests/tileAutotileRows.test.ts \
  apps/editor/tests/tileAutotileVisual.test.ts
npm run typecheck -w @hearth/core
npm run typecheck -w @hearth/runtime
npm run typecheck -w @hearth/editor
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/schema/components.ts \
  packages/core/src/commands/componentCommands.ts \
  packages/core/tests/tilemapFrameSource.test.ts \
  packages/runtime/src/pixi/tilemapRender.ts \
  packages/runtime/src/pixi/preload.ts \
  packages/runtime/tests/pixi-tilemapRender.test.ts \
  packages/runtime/tests/pixi-preload.test.ts \
  apps/editor/src/tileAutotileRows.ts \
  apps/editor/src/tileAutotileVisual.ts \
  apps/editor/src/components/Inspector.tsx \
  apps/editor/tests/tileAutotileRows.test.ts \
  apps/editor/tests/tileAutotileVisual.test.ts
git commit -m "Support fixed spritesheet frames in tilemaps"
```

### Task 4: Tilemap coherence validation

**Files:**

- Modify: `packages/core/src/validate.ts`
- Modify: `packages/core/tests/validate.test.ts`
- Modify: `packages/core/tests/tilemapFrameSource.test.ts`
- Modify: `docs/components.md`
- Modify: `docs/cli.md`

- [ ] **Step 1: Write one failing test per new stable code**

Construct scene fixtures and assert:

```ts
expect(issueCodes(report)).toContain('TILEMAP_UNMAPPED_CHAR');
expect(issueCodes(report)).toContain('TILEMAP_INVALID_CHAR_KEY');
expect(issueCodes(report)).toContain('TILEMAP_RESERVED_CHAR_KEY');
expect(issueCodes(report)).toContain('TILEMAP_SOURCE_NOT_IMAGE');
expect(issueCodes(report)).toContain('TILEMAP_FRAME_NOT_FOUND');
expect(issueCodes(report)).toContain('TILEMAP_FRAME_NOT_SQUARE');
expect(issueCodes(report)).toContain('TILEMAP_AUTOTILE_INVALID');
expect(issueCodes(report)).toContain('TILEMAP_TRANSFORM_UNSUPPORTED');
```

Add a clean mixed source fixture proving string, fixed frame, and complete
blob47 mappings emit none of the new issues.

- [ ] **Step 2: Run and verify RED**

```bash
npx vitest run packages/core/tests/validate.test.ts packages/core/tests/tilemapFrameSource.test.ts
```

Expected: assertions fail because the codes do not exist.

- [ ] **Step 3: Implement one shared Tilemap validator**

Create a local helper in `validate.ts` used for both scene components and
prefab payloads:

```ts
function validateTilemapSources(
  tilemap: TilemapComponent,
  transform: TransformComponent | undefined,
  assetsById: Map<string, Asset>,
  label: string,
): Array<{ severity: 'error' | 'warning'; code: string; message: string; asset?: string }>;
```

Rules:

- errors: invalid/reserved keys, used-but-unmapped chars, non-image sources,
  missing fixed frames, invalid autotile sheets/frames;
- warnings: non-square fixed frame and rotated/scaled Tilemap;
- retain `MISSING_TILE_ASSET`/`PREFAB_ASSET_NOT_FOUND` for missing asset IDs so
  existing consumers remain compatible;
- every message names one exact remediation;
- use `resolvedMapping` and `findSheetFrame` for all 47 autotile frames.

- [ ] **Step 4: Document the fixed source and constraints**

Add `{sheet,frame}` to `docs/components.md` and the CLI `set` example to
`docs/cli.md`. State that Tilemaps remain orthogonal square-cell grids and
must not be rotated/scaled; oversized art belongs on bottom-aligned sprites.

- [ ] **Step 5: Run focused and template/example validation**

```bash
npx vitest run packages/core/tests/validate.test.ts \
  packages/core/tests/tilemapFrameSource.test.ts \
  packages/templates/tests/scaffold.test.ts \
  packages/examples/tests/examples.test.ts
```

Expected: all pass and existing generated projects gain no new validation
errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/validate.ts packages/core/tests/validate.test.ts \
  packages/core/tests/tilemapFrameSource.test.ts \
  docs/components.md docs/cli.md
git commit -m "Validate tilemap asset coherence"
```

### Task 5: Skills, routing, and behavior proof

**Files:**

- Modify: `skills/hearth-art/SKILL.md`
- Modify: `skills/hearth-build/SKILL.md`
- Modify: `packages/core/src/agentFiles.ts`
- Modify: `packages/core/tests/agentSkill.test.ts`
- Modify: `docs/assets.md`
- Modify: `docs/mcp.md`
- Generated: `packages/core/src/agentSkillContent.ts`
- Generated: `packages/templates/templates/*/.claude/skills/{hearth-art,hearth-build}/SKILL.md`
- Generated: `packages/examples/*/.claude/skills/{hearth-art,hearth-build}/SKILL.md`
- Generated: template/example `AGENTS.md` and `CLAUDE.md`

- [ ] **Step 1: Run RED behavior probes against current skills**

Dispatch independent read-only subagents with only the current skill artifact
and one prompt each:

1. “Download and use this CC0 isometric dungeon pack to make a room.”
2. “Use this atlas; there is no README or TMX.”
3. “Recreate this Kenney pack’s walls from its loose Tiles directory.”

Record whether each agent inspects metadata/sample maps, uses vision,
distinguishes a fixed frame from blob47, identifies unsupported isometric
depth, and creates a proving ground. The expected baseline is at least one
unsafe guess, which establishes RED.

- [ ] **Step 2: Add failing semantic skill assertions**

In `agentSkill.test.ts`, require canonical embedded guidance to contain:

```ts
expect(art).toContain('hearth inspect asset-pack');
expect(art).toContain('reviewImages');
expect(art).toContain('exact');
expect(art).toContain('corroborated');
expect(art).toContain('inferred');
expect(art).toContain('unknown');
expect(build).toContain('{\"sheet\":\"');
expect(build).toContain('one Hearth entity per authored visual layer');
expect(build).toContain('proving ground');
```

Also assert generated AGENTS/CLAUDE routing mentions `inspect asset-pack` and
loads `hearth-art` before import and `hearth-build` before placement.

- [ ] **Step 3: Run and verify RED**

```bash
npx vitest run packages/core/tests/agentSkill.test.ts
```

Expected: new semantic assertions fail.

- [ ] **Step 4: Rewrite the canonical workflows concisely**

In `hearth-art`, add the mandatory source → inspect → vision → art contract →
proof flow, online provenance, confidence ladder, and hard stops from the
design. Correct the current over-broad “one tile size” rule to distinguish
logical cell footprint from oversized sprite rectangle.

In `hearth-build`, replace the advice to invent a blob47 sheet with explicit
selection among whole asset, `{sheet,frame}`, animation, genuine blob47,
separate authored layers, and bottom-aligned sprites. State that unsupported
isometric projection/depth must be rejected rather than flattened.

- [ ] **Step 5: Update top-level routing and public docs**

Teach generated agents to call `hearth inspect asset-pack` /
`inspect_asset_pack` before importing an unfamiliar pack and to visually read
`reviewImages`. Document the command/report in `docs/assets.md` and tool
listing in `docs/mcp.md`. Remove stale hard-coded command/tool totals rather
than incrementing prose counts.

- [ ] **Step 6: Sync and regenerate**

```bash
node scripts/sync-agent-skill.mjs
npm run build -w @hearth/core
node packages/templates/generate.mjs
node packages/examples/generate.mjs
```

Expected: embedded skills and every generated project copy update
deterministically.

- [ ] **Step 7: Run GREEN behavior probes**

Dispatch fresh subagents with equivalent prompts and the revised skill
artifact. Require all probes to call pack inspection, use vision on reported
images, preserve provenance, refuse unsupported geometry, and propose a
proving ground before production placement. If a probe finds a loophole,
tighten only the relevant instruction and rerun it.

- [ ] **Step 8: Run skill/scaffold tests**

```bash
npx vitest run packages/core/tests/agentSkill.test.ts \
  packages/templates/tests/scaffold.test.ts \
  packages/examples/tests/examples.test.ts
```

Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add skills/hearth-art/SKILL.md skills/hearth-build/SKILL.md \
  packages/core/src/agentFiles.ts packages/core/tests/agentSkill.test.ts \
  packages/core/src/agentSkillContent.ts docs/assets.md docs/mcp.md \
  packages/templates/templates packages/examples
git commit -m "Teach agents evidence-first asset handling"
```

### Task 6: Integration, documentation, and completion gate

**Files:**

- Modify: `docs/architecture.md`
- Modify: `docs/editor.md`
- Modify: `docs/roadmap.md`
- Modify: any exact-count tests surfaced by the full suite

- [ ] **Step 1: Update remaining public references**

Document `inspectAssetPack` in the command registry architecture, the editor’s
three Tilemap source modes, and the shipped capability in the roadmap. Prefer
count-free prose. Update exact test counts only where the count is itself the
contract.

- [ ] **Step 2: Run formatting and generated-artifact checks**

```bash
git diff --check
node scripts/sync-agent-skill.mjs
git diff --exit-code packages/core/src/agentSkillContent.ts
npm run build -w @hearth/core
node packages/templates/generate.mjs
node packages/examples/generate.mjs
git diff --exit-code packages/templates/templates packages/examples
```

Expected: no drift after regeneration.

- [ ] **Step 3: Run package builds and typechecks**

```bash
npm run build:packages
npm run typecheck
```

Expected: all workspaces build and typecheck.

- [ ] **Step 4: Run the full test suite**

```bash
npx vitest run
```

Expected: all tests pass. Do not pipe through `tail`; preserve the real exit
status.

- [ ] **Step 5: Run real CLI and MCP smoke tests**

Create a temporary Hearth project plus a tiny synthetic pack, then verify:

```bash
hearth inspect asset-pack ./pack --license CC0-1.0 --json
```

returns ordered metadata and no project mutation. Call `inspect_asset_pack`
over the MCP test client and compare its `data` to the CLI command result.
Create a sliced sheet, assign one Tilemap char with `{sheet,frame}`, render a
screenshot, and confirm the selected frame appears without a whole-sheet
fallback warning.

- [ ] **Step 6: Review the final diff**

Check:

- no unrelated user changes were overwritten;
- all new operations pass through the registry or established Node-only
  observation seam;
- CLI/MCP names and schemas agree;
- fixed-frame and blob47 object arms are never confused;
- unsupported pack features remain explicit;
- generated skill copies byte-match canonicals; and
- the working tree contains no build/release artifacts.

- [ ] **Step 7: Commit**

```bash
git add docs/architecture.md docs/editor.md docs/roadmap.md
git commit -m "Document asset pack intelligence"
```

If integration required code/test corrections, include only those focused
files in the same commit and explain them in its body.
