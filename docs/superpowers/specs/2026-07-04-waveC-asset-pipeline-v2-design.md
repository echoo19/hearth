# Wave C — Asset Pipeline v2 (spritesheets, music, fonts, editor asset UX)

**Date:** 2026-07-04 · **Target version:** v0.6.0
**Backlog source:** `docs/superpowers/specs/2026-07-02-v0.3-engine-systems-backlog.md` §6 (asset pipeline v2) + editor UX + docs/examples.

**North star (Jake, 2026-07-04):** every feature must branch the possibility
space of what users and agents can make. Wave C is the "real art, real
sound, real typography" wave — the difference between programmer-rectangle
demos and games that look and feel like someone's own. Concretely: after
this wave, any free asset pack (Kenney-style spritesheets, an OFL font, a
music loop) drops into Hearth and works end to end — import, slice, animate,
play, export — driven entirely by commands, so agents can do it too.

**Standing rules (unchanged):** agent-native first (schemas + commands +
headless asserts before editor UI); no engine chrome in shipped games;
determinism preserved (nothing here touches the fixed-timestep simulation);
free OSS core, nothing gated.

---

## 1. Scope

In scope:

1. **Imported-image metadata** — probe width/height/format at import.
2. **Spritesheet slicing** — grid slicing into named frames; SpriteRenderer
   sub-rect rendering; animations from sheet frames; texture tinting.
3. **Music streaming** — dedicated music channel with fades; streamed (not
   fully decoded) playback in browsers; `AudioSource.music` autoplay.
4. **Font assets** — imported fonts actually load; `Text.fontFamily`
   resolves them by asset name everywhere (editor, player, exports).
5. **`assertAudioCount`** playtest assertion (audio becomes testable).
6. **Editor asset UX** — slice dialog with live preview, Inspector
   dropdowns for frames/fonts, better AssetsPanel previews, multi-file drop.
7. **New example game** proving the whole pipeline with imported binary
   assets, plus docs.

Out of scope (explicitly deferred): UI widgets v2 (layout containers,
sliders, focus); audio sprites/positional audio; non-grid (freeform) slicing
UI; MSDF/bitmap font rendering; asset hot-reload during play; Wave D agent
panel.

## 2. Current state (verified 2026-07-04)

- `AssetSchema` (`packages/core/src/schema/project.ts:63-78`) is flat:
  `{id, name, type, path, metadata: record(unknown)}`; `ASSET_TYPES`
  already includes `'font'`. `importAsset`
  (`packages/core/src/commands/assetCommands.ts:45-81`) copies the file and
  never probes anything.
- Animations (`AnimationDataSchema`, `project.ts:81-86`) are lists of whole
  sprite asset ids; `SpriteRenderer` has no source-rect and never tints
  textures (`packages/runtime/src/pixi/index.ts:748-777`).
- `WebAudioPlayer` (`packages/runtime/src/pixi/audio.ts`) fully
  `decodeAudioData`s every asset; no streaming, no fades, no music concept.
  Headless playtests record `audioEvents: {frame, assetId, action}`.
- Fonts: importable but never loaded — `Text.fontFamily` hits system fonts
  only (`pixi/index.ts:714-728`).
- Export bundle asset entries are `{id, name, type, path?, dataUri?}` —
  **no metadata** (`packages/core/src/commands/exportCommands.ts:16-22`).
- Editor AssetsPanel has raw `<img>`/`<audio>` previews, single-asset
  workflows, no slicing UI.
- All 6 examples are 100% procedural; none imports a binary asset.

## 3. Alternatives considered

**Spritesheet model** — chosen: **(a) typed frames on the sheet asset +
`frame` field on SpriteRenderer.** Frames live in the image asset's
`metadata.frames`, validated by a Zod schema at every read/write site; the
renderer builds sub-textures on demand. Rejected: (b) slicing into N
derived per-frame assets — explodes the asset index (a 64-frame sheet =
64 assets), loses the sheet as a unit, and re-slicing orphans ids;
(c) a new `atlas` asset type with a sidecar JSON file — a second file to
keep in sync and a special case in export/player for no added power.

**Music playback** — chosen: **(a) dedicated single music channel**
(`playMusic`/`stopMusic`/`setMusicVolume`). "The music" is a first-class
concept: starting a new track replaces the old (with fades), and agents can
assert on it. Rejected: (b) a `stream: true` option on `ctx.audio.play` —
leaves replace/fade semantics to every script author and gives streaming an
API surface identical to SFX when browsers treat them differently;
(c) a new `music` asset type — the same file is validly SFX or music;
behavior belongs to playback, not the asset.

**Font loading** — chosen: **(a) FontFace registration at preload, family
name = asset name**, referenced through the existing `Text.fontFamily`
string. Zero schema change, works in editor/player/single-file exports
alike. Rejected: (b) Pixi BitmapFont pre-baking — quality/perf work that
matters at scale we don't have; (c) CSS `@font-face` injection — Node-less
contexts (headless) and single-file exports get messier than the FontFace
API, which works from data URIs directly.

## 4. Design

### 4.1 Imported-image metadata

New pure module `packages/core/src/assets/imageInfo.ts`:

```ts
export interface ImageInfo { width: number; height: number; format: 'png' | 'jpeg' | 'gif' | 'webp' | 'svg' }
export function probeImage(bytes: Uint8Array): ImageInfo | null
```

Byte-level parsers, no dependencies: PNG IHDR; JPEG SOF0/1/2 scan; GIF
logical screen descriptor; WebP VP8/VP8L/VP8X; SVG best-effort text scan
for `width`/`height` attributes then `viewBox` (rounded to ints). Returns
`null` when unrecognized or dimensionless (e.g. an SVG with neither) —
never throws.

`importAsset` change: when the derived type is `sprite` or `tile`, read the
copied bytes (`ctx.fs.readFileBinary`) and merge `{width, height, format}`
into `metadata` when probing succeeds. Probe failure is silent (import
still succeeds). Existing `importedFrom` metadata stays.

### 4.2 Spritesheets

**Frame schema** (in `packages/core/src/schema/project.ts`):

```ts
export const SpritesheetFrameSchema = z.object({
  name: z.string().min(1),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
})
export type SpritesheetFrame = z.infer<typeof SpritesheetFrameSchema>
```

Frames are stored as `asset.metadata.frames` (array). A single accessor in
core is the only sanctioned read path:

```ts
// packages/core/src/assets/sheetFrames.ts
export function getSheetFrames(asset: Asset): SpritesheetFrame[]  // [] if absent/invalid
export function findSheetFrame(asset: Asset, name: string): SpritesheetFrame | null
```

Runtime, renderer, validation, editor, and commands all go through these —
no site re-parses `metadata.frames` by hand.

**`sliceSpritesheet` command** (`assetCommands.ts`):

- Params: `asset` (id or name), `frameWidth` (int > 0), `frameHeight`
  (int > 0), `margin` (int ≥ 0, default 0 — outer border), `spacing`
  (int ≥ 0, default 0 — gap between cells), `namePrefix` (optional string;
  default: slug of the asset name).
- Behavior: asset must be type `sprite` or `tile`. Reads the image file,
  probes dimensions directly (does not require import-time metadata; also
  backfills `width`/`height` metadata while it's there). Unprobeable image
  (including dimensionless SVG) → `INVALID_INPUT` error naming the reason.
  Computes the row-major grid: columns =
  `floor((imgW - 2*margin + spacing) / (frameWidth + spacing))`, same for
  rows; must yield ≥ 1 frame or `INVALID_INPUT`. Frames named
  `<namePrefix>_<index>` (zero-based, row-major). Writes
  `metadata.frames` (replacing any previous slice) and
  `metadata.grid = {frameWidth, frameHeight, margin, spacing}`.
- Result data: `{assetId, frameCount, columns, rows, frames: [names]}`.
  If the grid leaves trailing pixels (image not evenly divisible), the
  command succeeds and includes a warning string in the result
  (`"sheet is 130x64; 2px unused on the right"`-style).
- Re-slicing is allowed and replaces frames; validation (below) will flag
  any now-dangling frame references.

**SpriteRenderer** gains one field:

```
frame: z.string().nullable().default(null)   // frame name within assetId's sheet
```

Renderer behavior (`buildSpriteRenderable` + snapshot key in
`pixi/index.ts`): when `assetId` resolves to a texture and `frame` names a
frame on that asset (via `findSheetFrame`), draw a cached sub-texture
(cache key `${assetId}#${frameName}`); the sub-texture is created once per
key from the base texture's source with the frame rect. Unknown frame name
or asset without frames → warn once per (assetId, frame) pair and draw the
whole texture. `frame` joins `spriteSnapshotKey` so live edits rebuild the
node. `width`/`height` still set world size exactly as today.

**Texture tint (included in this wave):** the textured branch of
`buildSpriteRenderable` now applies `sprite.color` as the Pixi tint and
keeps applying `opacity` as alpha. Default color `#ffffff` = identity, so
every existing project renders identically. This turns one spritesheet
into many palettes — cheap, high-branching.

**Animations from sheets.** `AnimationDataSchema.frames` entries remain
strings; a frame entry may now be either an asset ref (as today) or
`"<assetId>#<frameName>"`. `stepAnimator` output widens from a plain asset
id to `{assetId, frame: string | null}`; the runtime writes both fields
into the sibling SpriteRenderer. Preloading collects sheet assets
referenced via `#` refs. Written files always use asset **ids** before the
`#` (names are resolved at creation time).

New command `createAnimationFromSheet` (`assetCommands.ts`):

- Params: `name`, `sheet` (asset id or name), `frames` (array of frame
  names, min 1), `frameDuration` (default 0.15), `loop` (default true).
- Validates the sheet has been sliced and every named frame exists
  (`INVALID_INPUT` listing missing names otherwise); writes a standard
  `.anim.json` whose entries are `"<sheetAssetId>#<frameName>"`; registers
  the animation asset exactly like `createAnimationAsset` (same id quirk,
  same metadata plus `sheet: <assetId>`).

**Validation** (`packages/core/src/validate.ts`), same style as Wave B's
collider warnings:

- `FRAME_NOT_FOUND` (warning): a SpriteRenderer sets `frame` but the
  referenced asset has no frame of that name (or no frames at all).
- `ANIMATION_FRAME_NOT_FOUND` (warning): an animation asset's `.anim.json`
  contains a `#` ref whose sheet asset or frame name doesn't resolve.

**Inspectability:** `inspectAssets` already returns assets; ensure the
JSON includes `metadata` so agents see frames, grid, and dimensions
without extra plumbing.

### 4.3 Music streaming

**`ctx.audio` additions** (both JS and Lua bindings, documented in
`inspect api` / ctxApi docs):

```ts
ctx.audio.playMusic(assetRef, opts?)   // opts: { volume?: 0..1 = 1, loop?: boolean = true, fadeIn?: seconds = 0 }
                                        //  -> handle id 'mus_<n>' | null
ctx.audio.stopMusic(opts?)              // opts: { fadeOut?: seconds = 0 }
ctx.audio.setMusicVolume(volume, opts?) // opts: { fade?: seconds = 0 }
```

Semantics: **one music channel.** `playMusic` while music is playing stops
the current track (honoring the new call's `fadeIn` as a crossfade-out
duration for the old track — i.e. old fades out over `fadeIn` seconds
while new fades in) and starts the new one. `playMusic` with an unknown
asset ref warns and returns `null` (matching `ctx.audio.play`).
`stopMusic`/`setMusicVolume` when nothing is playing are no-ops. Music
does not restart on scene switch (it's session-scoped, like today's
looping SFX); scripts stop/start it explicitly.

**Recording (headless + hosts):** `AudioEvent` gains an optional flag —
`{frame, assetId, action: 'play' | 'stop', music?: true}` — and music
start/stop pushes events with `music: true`. `setMusicVolume` is not
recorded (it's a mix decision, not an event). GameSession/playtest reports
carry these in the existing `audioEvents` array unchanged in shape.

**Web host** (`packages/runtime/src/pixi/audio.ts`): music plays through
`new Audio(url)` (`crossOrigin='anonymous'`, `preload='auto'`,
`loop` from opts) wrapped in `createMediaElementSource` → per-track
`GainNode` → existing master gain. The element **streams**; no
`decodeAudioData`. Fades are `gain.linearRampToValueAtTime` ramps;
`stopMusic({fadeOut})` ramps to 0 then pauses/releases the element. The
existing suspended-context unlock queue treats queued music like today's
queued loops (start from 0 on unlock, never dropped as stale). Data-URI
sources (single-file exports) work — `Audio` accepts them (fully in memory
in that mode by nature; multi-file exports and the editor stream from
URLs).

**`AudioSource` component** gains `music: z.boolean().default(false)`.
The existing autoplay path calls `playMusic` instead of `play` when set,
passing the component's own `volume` and `loop` values (no fade) — a scene
gets a soundtrack with zero scripting. Entering a scene whose AudioSource
autoplays music while the same considerations apply as any `playMusic`
call: it replaces whatever is playing.

**`assertAudioCount` playtest assertion** (schema in `project.ts`,
executor in `packages/playtest/src/index.ts`, mirroring
`assertEventCount` including the ≥1-bound `superRefine`):

```
{ type: 'assertAudioCount', asset?: string, action?: 'play' | 'stop', music?: boolean,
  equals?: int, min?: int, max?: int }
```

Counts entries of the run's `audioEvents` matching every provided filter
(`asset` matches the event's assetId resolved from id **or name** at
assert time; omitted filters match all). Exposed through
`createPlaytest`/CLI/MCP automatically via the schema union.

### 4.4 Font assets

- `EXT_TO_TYPE` in `assetCommands.ts` adds `woff` (ttf/otf/woff2 already
  map to `font`).
- `PixiSceneView` preload gains `loadFonts()`: for every `font` asset,
  `new FontFace(asset.name, url(...))`, `await load()`,
  `document.fonts.add(...)` — awaited alongside `preloadTextures` before
  first render. Family name is exactly the **asset name**; load failure
  warns and continues. Works identically in the editor (fileUrl), player
  multi-file (relative path), and single-file (data URI) because it rides
  `resolveAssetUrl`.
- `Text.fontFamily` (existing field) referencing the asset name now just
  works; unknown families fall back to the browser default as today. No
  schema change, no validation warning (generic CSS families must stay
  legal and a hard list would misfire).
- Headless runs don't render, so no font work there.

### 4.5 Editor asset UX

All controls follow Jake's uniformity bar: typed, cohesive controls —
never raw JSON. UI tasks apply the `impeccable` design skill.

- **Slice dialog** (AssetsPanel): a "Slice…" action on sprite/tile assets
  opens a modal with number fields (frame width/height, margin, spacing)
  and a name-prefix text field, a live preview of the image with the
  computed grid overlaid, and a computed "N frames (C × R)" readout that
  updates as values change; confirm calls `sliceSpritesheet`. Already-
  sliced sheets prefill from `metadata.grid`.
- **Asset details**: sliced sheets show a frame-grid preview (each cell
  cropped via CSS background-position from the same image URL) with frame
  names; fonts render an "Aa Bb 0123 — Hearth" sample line using the
  FontFace API; animations show a first-frame thumbnail instead of the
  generic icon (cropped when the first frame is a `#` ref).
- **Inspector**: `SpriteRenderer.frame` renders as a dropdown of the
  selected asset's frame names plus "(whole image)" — only when the
  assigned asset has frames, otherwise the field stays hidden;
  `Text.fontFamily` renders as a dropdown of font asset names + the five
  generic CSS families + a custom-entry option; `AudioSource.music` is the
  standard boolean toggle (comes free from the existing field renderer).
- **Multi-file import**: verify drag-drop and the Import… picker handle
  multiple files in one gesture (iterate all; report per-file results);
  fix if single-file today.

### 4.6 Example game + fixtures ("Sky Courier")

A seventh example proving the pipeline with **imported binary assets** —
today zero examples import anything. A small platformer-flavored delivery
game: an animated pixel courier (spritesheet walk/idle), parcels to
collect, a streamed chiptune loop, score UI in a real pixel font.

- **Spritesheet**: generated **deterministically at generate time** by a
  pure-Node PNG encoder inside `packages/examples/` (RGBA pixel buffer →
  zlib.deflateSync → hand-built PNG chunks; no dependencies). The
  generator draws a small character sheet (e.g. 6 frames of 16×16:
  4 walk + 2 idle) to a temp file, `importAsset`s it, then
  `sliceSpritesheet` + `createAnimationFromSheet`.
- **Music**: a short synthesized WAV loop (square/triangle chiptune, a few
  bars, seeded/deterministic) written the same way and imported; scene's
  `AudioSource {music: true, autoplay: true}` plays it.
- **Font**: a checked-in fixture at `packages/examples/fixtures/fonts/`
  — an OFL-licensed pixel font (Press Start 2P) with its `OFL.txt` license
  beside it; `generate.mjs` imports it and Text UI uses
  `fontFamily: <asset name>`.
- **Playtests**: baked from probe runs per the standing rule; include
  `assertAudioCount {music: true, action: 'play', equals: 1}` and
  movement/collection asserts; `assertNoErrors` everywhere.
- Examples remain fully regenerable: `generate.mjs` + fixtures are the
  source of truth; generated PNG/WAV bytes are identical run to run.

### 4.7 Cross-cutting

- **Export bundle carries `metadata`**: `WebExportBundle` asset entries
  gain `metadata` (`exportCommands.ts:16-22, 230-232`) so frames/grid/
  dimensions reach the player. Player passes assets through unchanged —
  sub-rect logic lives in the shared renderer.
- **CLI**: `hearth asset slice <asset> --frame-size WxH [--margin N]
  [--spacing N] [--prefix name]` and `hearth asset anim-from-sheet <name>
  --sheet <asset> --frames a,b,c [--duration s] [--no-loop]` (leaf names
  final at plan time, following existing `program.ts` conventions);
  playtest CLI needs no change (assertion rides the schema).
- **MCP**: `slice_spritesheet`, `create_animation_from_sheet` ToolSpecs;
  existing `import_asset`/`inspect_assets` unchanged in name.
- **Versioning**: v0.6.0 across all packages + the three hardcoded
  constants (core HEARTH_VERSION, CLI VERSION, MCP SERVER_VERSION);
  examples regenerate carrying 0.6.0.
- **Docs**: new `docs/assets.md` (import → probe → slice → animate →
  music → fonts, with agent-oriented CLI/MCP walkthroughs); updates to
  components.md (frame, tint, AudioSource.music), scripting.md (music
  API), cli.md, mcp.md, architecture.md (asset pipeline section),
  roadmap.md ("Shipped in v0.6.0"); mcp-server README tool table.

## 5. Testing strategy

- Unit: `probeImage` against hand-built byte fixtures for all five
  formats + garbage input; slicing grid math (margin/spacing/uneven
  sheets/1×1); `getSheetFrames` rejecting malformed metadata;
  `stepAnimator` with `#` refs; `assertAudioCount` filter matrix;
  music-channel semantics on a stub host (replace, fade values recorded,
  stop-when-idle no-op).
- Runtime integration (vitest, headless): animator writes
  `assetId`+`frame` to SpriteRenderer; audioEvents carry `music: true`;
  AudioSource music autoplay records on frame 0.
- Chromium-gated (existing pattern): a sliced sheet renders — pixels
  change when `frame` changes; tinted texture differs from white; FontFace
  loads and Text renders with it (compare pixels vs system-font render);
  music element created (stubbed `Audio` where real playback is
  unavailable).
- Playtest end-to-end: Sky Courier's baked playtests green; full suite +
  `npm run typecheck` (vitest does not typecheck — standing rule).
- Determinism: two runs of `generate.mjs` produce byte-identical PNG/WAV
  fixtures; example playtests use probe-baked expectations.

## 6. Risks

- **PNG encoder correctness** — mitigated: uncompressed-idat-free simple
  encoder with node zlib, CRC32 table is 15 lines, verified by importing
  the output through `probeImage` and rendering it in the Chromium test.
- **FontFace in Pixi text** — Pixi resolves `fontFamily` at Text creation;
  fonts are awaited before first render so no FOUT; live-added fonts in
  the editor take effect on next node rebuild (acceptable; note in docs).
- **MediaElementSource + data URIs** — works in Chromium/WebKit/Gecko;
  single-file exports lose true streaming by nature (documented).
- **Metadata as frame store** — guarded by the single accessor + Zod
  validation at the boundary; the editor never shows raw metadata JSON
  (uniformity rule).
