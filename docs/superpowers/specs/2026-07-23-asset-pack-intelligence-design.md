# Asset Pack Intelligence Design

**Date:** 2026-07-23
**Status:** Approved design, pending implementation plan

## Problem

Hearth agents can import images and slice uniform sheets, but they do not have a
reliable intake process for a third-party asset pack. Current skills tell the
agent to look at the art and keep a coherent palette, yet the agent still has
to guess:

- whether a sheet contains standalone sprites, connective terrain, animation
  frames, or oversized decorations;
- how a pack's tiles connect and which layers belong above or below actors;
- whether the logical grid footprint differs from the sprite rectangle;
- whether a sample TMX/TSX map contains information Hearth cannot represent;
- whether an online pack is licensed and attributed correctly; and
- whether a sliced frame can be used as a fixed Tilemap source.

Those guesses produce stretched tiles, repeated outlined blocks, malformed
walls, flattened layers, lost flip/collision data, and especially poor
isometric maps. The engine must make supported paths easy and unsupported paths
explicit. It must not pretend that every pack can become a Hearth Tilemap.

## Goals

1. Give agents a deterministic command for inspecting a downloaded asset pack
   before import or placement.
2. Make online packs follow the same evidence-first flow as local packs.
3. Expose the command through the shared command registry, CLI, and MCP.
4. Let a Tilemap cell use one fixed frame from a sliced sheet.
5. Add project validation that catches the Tilemap mistakes agents currently
   ship.
6. Tighten Hearth's scaffolded skills and agent routing so agents call the new
   surfaces automatically.
7. Require a small rendered proving ground and visual comparison before an
   agent accepts a pack for production scenes.

## Non-goals

- A general TMX/TSX importer.
- Native isometric, staggered, or hexagonal Tilemap rendering.
- Runtime Y sorting or dynamic wall occlusion.
- AI inference inside the deterministic Hearth engine.
- Scraping, downloading, or accepting website license terms inside Hearth.
- Automatic collision generation from opaque pixels.
- Supporting every atlas metadata format in the first release.

The inspection report must identify these boundaries. An agent may use
individual bottom-anchored sprites as a fallback only when a proving-ground
render demonstrates that the result preserves the pack's intended appearance.
Otherwise it must select a compatible pack or ask the user.

## Operating Flow

### 1. Source

For an online pack, the agent:

1. asks for approval before downloading;
2. records the listing URL, author, exact license, attribution requirements,
   and download date;
3. downloads the complete pack, including README, license, sample screenshots,
   source images, and map metadata; and
4. keeps vendor files unchanged.

Hearth does not browse or download. The local downloaded directory is the
input to the shared inspection command.

### 2. Inspect

The agent runs:

```bash
hearth inspect asset-pack ./downloads/pack \
  --source-url https://example.test/pack \
  --author "Example Author" \
  --license CC0-1.0 \
  --json
```

Optional visual output:

```bash
hearth inspect asset-pack ./downloads/pack \
  --contact-sheet ./pack-review.png \
  --json
```

The equivalent MCP tool is `inspect_asset_pack`. It accepts the same semantic
inputs, with separate fields instead of CLI flags.

Inspection is read-only with respect to the game project. Writing an explicitly
requested contact-sheet output is the only filesystem change.

### 3. Review with vision

The engine reports machine facts. The agent uses its image-reading capability
on the report's ordered `reviewImages` and optional contact sheet to identify:

- floor, wall top, wall face, edge, corner, end cap, and interior tiles;
- props, actors, animation sequences, shadows, and light direction;
- likely footprint/feet anchors for oversized or depth-sensitive art;
- palette, outline weight, pixel density, and filtering expectations; and
- mismatches between loose tiles and the pack's own screenshots or sample maps.

The skills define four evidence levels:

- `exact`: declared by metadata or documentation;
- `corroborated`: visual observation agrees with a sample map or screenshot;
- `inferred`: vision-only interpretation that requires a proving-ground test;
- `unknown`: insufficient evidence, so the agent must ask or reject.

The deterministic command never labels a visual inference as an exact fact.

### 4. Represent

The agent chooses the narrowest faithful Hearth representation:

- whole image: `SpriteRenderer.assetId`;
- fixed atlas tile: Tilemap source `{ "sheet": "...", "frame": "..." }`;
- animation: sliced sheet plus animation asset;
- connective blob terrain: complete blob47 mapping;
- authored visual layers: one Hearth entity per source layer;
- oversized or depth-sensitive art: bottom-aligned `SpriteRenderer` entities;
- collision, navigation, and triggers: separate semantic entities or Tilemaps,
  not inferred from opaque pixels.

An unsupported feature is never silently discarded.

### 5. Prove

Before building a production level, the agent creates a tiny scene that covers
the risky parts of the pack:

- seams and atlas boundaries;
- straight edges, corners, inner corners, and end caps;
- tall walls and an actor placed in front of and behind them;
- every permitted flip or directional variant;
- animation alignment;
- collision footprint; and
- actual gameplay camera scale.

The agent captures a deterministic screenshot, compares it with the pack's
sample material, runs `hearth validate --json`, and accepts the pack only after
both checks pass.

## Shared Command: `inspectAssetPack`

`inspectAssetPack` is a read-only registry command. The CLI and MCP are thin
adapters over the same command result envelope.

### Input

```ts
{
  path: string;
  sourceUrl?: string;
  author?: string;
  license?: string;
  contactSheet?: string;
}
```

The host resource boundary performs directory walking and file reads, matching
the existing asset-import architecture. Core owns schemas, parsing,
classification, diagnostics, and report ordering.

### Output

```ts
{
  root: string;
  status: "compatible" | "partial" | "unsupported";
  provenance: {
    sourceUrl?: string;
    author?: string;
    license?: string;
    evidenceFiles: string[];
  };
  files: Array<{
    path: string;
    kind: "image" | "audio" | "font" | "map" | "tileset" |
          "metadata" | "license" | "readme" | "other";
  }>;
  images: Array<{
    path: string;
    width?: number;
    height?: number;
    format?: string;
    referencedBy: string[];
  }>;
  maps: Array<{
    path: string;
    format: "tmx" | "tiled-json";
    orientation?: string;
    tileWidth?: number;
    tileHeight?: number;
    width?: number;
    height?: number;
    layers: Array<{
      name: string;
      type: string;
      visible?: boolean;
      opacity?: number;
      offsetX?: number;
      offsetY?: number;
    }>;
    tilesets: Array<{
      firstGid?: number;
      source?: string;
      tileWidth?: number;
      tileHeight?: number;
      columns?: number;
      margin?: number;
      spacing?: number;
      tileOffset?: { x: number; y: number };
      objectAlignment?: string;
      wangSetCount?: number;
    }>;
    features: string[];
  }>;
  diagnostics: Array<{
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
    evidence: string[];
    suggestion?: string;
  }>;
  reviewImages: string[];
  reviewChecklist: string[];
  contactSheet?: string;
}
```

The exact TypeScript types may be split into focused schemas, but the command
must preserve this information and deterministic ordering.

### Pack diagnostics

Initial stable diagnostic codes:

- `PACK_LICENSE_UNKNOWN`
- `PACK_METADATA_MISSING`
- `PACK_VISUAL_REVIEW_REQUIRED`
- `PACK_ISOMETRIC_UNSUPPORTED`
- `PACK_ORIENTATION_UNSUPPORTED`
- `PACK_TILE_FLIPS_UNSUPPORTED`
- `PACK_OBJECT_LAYER_UNSUPPORTED`
- `PACK_TILE_OFFSET_UNSUPPORTED`
- `PACK_MIXED_TILE_SIZE`
- `PACK_OVERSIZED_TILE`
- `PACK_COLLISION_NOT_IMPORTED`
- `PACK_TERRAIN_RULES_NOT_IMPORTED`

`unsupported` means one or more required visual/map features cannot be
represented faithfully. `partial` means the pack is usable only through named
fallbacks and explicit proof. `compatible` does not waive visual review.

### Supported metadata in the first release

- PNG, JPEG, GIF, WebP, and SVG dimensions through the existing image probe;
- TMX and external TSX XML;
- Tiled JSON maps and external JSON tilesets;
- uncompressed finite tile-layer metadata sufficient to detect GID flags,
  layer structure, orientation, offsets, object layers, terrain/Wang metadata,
  and oversized tiles.

The command analyzes metadata but does not convert a map into a scene. Base64,
compression, infinite chunks, templates, and image layers may be reported but
need not be decoded beyond compatibility diagnostics.

### Contact sheet

The optional contact sheet is a review aid, not a semantic classifier. It:

- uses deterministic path ordering;
- shows the source file name and dimensions;
- preserves nearest-neighbor rendering for pixel art;
- includes loose images and atlas sheets without cropping away context; and
- caps thumbnail size and total page size predictably.

The implementation may reuse the existing browser-canvas/Playwright capture
path rather than adding an image-decoding dependency. The core report remains
usable when contact-sheet generation is unavailable.

## Fixed Tilemap Frame Source

Extend `TileAsset` from:

```ts
string | AutotileRule
```

to:

```ts
string | { sheet: string; frame: string } | AutotileRule
```

The new arm selects a named frame created by `sliceSpritesheet`. It is a fixed
visual source and performs no neighbor lookup.

Required consumers:

- component schema and exported types;
- command property validation;
- runtime Tilemap renderer;
- editor Scene View Tilemap renderer and paint preview;
- Inspector Tilemap source controls;
- project validation;
- project export/preload asset discovery;
- docs and generated skills.

The renderer continues to draw one square `tileSize` cell. Validation warns
when the selected frame is not square because that render would distort the
source. Oversized wall/decorative frames belong on sprites, not this source.

## Project Validation

Add stable validation issues for:

- `TILEMAP_UNMAPPED_CHAR`: a non-empty grid character has no source;
- `TILEMAP_INVALID_CHAR_KEY`: a source key is not exactly one character;
- `TILEMAP_RESERVED_CHAR_KEY`: `.` or space is used as a source key;
- `TILEMAP_SOURCE_NOT_IMAGE`: a plain or sheet source is not a sprite/tile;
- `TILEMAP_FRAME_NOT_FOUND`: a fixed frame does not exist on its sheet;
- `TILEMAP_FRAME_NOT_SQUARE`: a fixed frame will be distorted into a square;
- `TILEMAP_AUTOTILE_INVALID`: the sheet is unsliced or an effective frame is
  missing;
- `TILEMAP_TRANSFORM_UNSUPPORTED`: a Tilemap entity has non-zero rotation or
  non-identity scale while paint, physics, and pathfinding remain untransformed.

Messages include one exact remediation. Existing valid projects remain valid.
New warnings/errors target states that already render incorrectly or disagree
with physics.

## Skill and Agent Routing

### `hearth-art`

Add a mandatory pack-intake section:

1. source with explicit approval and provenance;
2. run `inspect asset-pack`;
3. inspect every `reviewImages` item with vision;
4. prefer metadata/sample-map evidence over filename or index guesses;
5. create an art contract covering projection, footprint, anchor, scale,
   palette, outline, filtering, shadow, and light direction;
6. record confidence for inferred roles;
7. stop on unknown license or unsupported/lossy geometry; and
8. require the proving-ground screenshot before production use.

### `hearth-build`

Add representation guidance:

- choose whole asset, fixed frame, animation, blob47, or bottom-aligned sprite
  based on the inspection report;
- use one Hearth entity per authored visual layer;
- keep floor, wall faces/tops, decorations, collision, and triggers separate;
- never rotate or scale a Tilemap;
- never use a fixed square Tilemap cell for oversized/depth-sensitive art;
- never invent blob47 mappings from an unrelated atlas; and
- reject isometric packs that require unsupported projection or dynamic depth.

### Top-level routing

Update generated `AGENTS.md` and `CLAUDE.md` guidance so any task involving a
downloaded pack, spritesheet, tileset, or online art source loads `hearth-art`
before import and `hearth-build` before placement. Mention
`inspect_asset_pack`/`hearth inspect asset-pack` directly so non-Claude agents
discover the tool.

Canonical skills remain under `skills/`. Run the existing synchronization and
template/example generators so embedded and scaffolded copies remain byte
identical.

## Error Handling and Safety

- Inspection never mutates project state.
- An unreadable path or malformed declared metadata fails the command with the
  normal command error envelope.
- Unsupported pack features normally produce a successful inspection command
  with `data.status: "unsupported"` and stable diagnostics. Inspection itself
  succeeded; faithful use did not.
- Unknown licenses are errors in the report, not guessed from the hosting site.
- Paths in output are normalized relative to the inspected root.
- Directory traversal stays under the requested root. Symlinks that escape the
  root are rejected or skipped with a diagnostic.
- File count, individual file size, metadata nesting, map dimensions, and
  contact-sheet dimensions have explicit caps.
- XML parsing does not resolve external entities or fetch network resources.
- Online fetching remains outside Hearth and follows the existing user-approval
  and licensing rules.

## Testing

### Core command

Use synthetic fixtures for:

- loose sprites plus README/license;
- a uniform TSX atlas with margin and spacing;
- multiple `firstgid` tilesets;
- orthogonal TMX layers;
- isometric orientation;
- oversized/tile-offset art;
- GID flip flags;
- object/collision layers;
- Wang sets;
- malformed XML/JSON;
- symlink escape and file-size/count caps; and
- deterministic report ordering.

### Tilemap frame source

Test schema acceptance/rejection, runtime texture selection, editor preview
selection, export/preload discovery, property mutation, missing frames, and
backward compatibility for string and blob47 sources.

### Validation

Pin every new code with one failing and one passing fixture. Confirm old
examples/templates do not acquire new issues.

### CLI and MCP

Verify both adapters return the same command data and diagnostics. Verify the
contact sheet only writes when requested.

### Skill behavior

Before editing skills, run ambiguous asset-pack prompts against an agent with
the current skills and record its mistakes. After editing, rerun equivalent
prompts and require that it:

- calls pack inspection before import;
- uses vision on the reported images;
- preserves provenance;
- distinguishes fixed frames from blob47 terrain;
- refuses unsupported isometric/depth behavior;
- creates a proving ground; and
- does not claim completion from validation alone.

### Completion gate

Run focused package tests, skill synchronization/generation checks, the full
Vitest suite, package builds, and a CLI/MCP smoke test against a synthetic
pack.

## Implementation Boundaries

The work can be split after the implementation plan is approved:

1. pack inspection schemas/parser/command;
2. CLI, MCP, host resources, and contact-sheet adapter;
3. fixed Tilemap frame source plus validation;
4. canonical skills, agent routing, synchronization, and behavior tests.

These slices may be developed in parallel once shared schemas and command names
are pinned. Integration must review generated artifacts and run the full suite
after all slices land.

## Success Criteria

An agent given an unfamiliar local or approved online asset pack can:

1. discover and call the shared inspection command;
2. explain what is known from metadata versus inferred with vision;
3. choose a faithful Hearth representation or explicitly reject the pack;
4. use fixed atlas frames in Tilemaps without duplicating files or abusing
   blob47;
5. preserve licensing/provenance;
6. prove visual cohesion in a rendered scene; and
7. pass strict validation without silent loss of pack semantics.
