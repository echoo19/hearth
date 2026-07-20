# Asset Pipeline Guide

How real art, spritesheets, music, and fonts get into a Hearth project:
import, probe, slice, animate, and play, plus the playtest step that
proves audio actually happened. Everything here works identically from a
human's editor click, an agent's CLI/MCP call, or a script's `ctx` call;
the differences that do exist (a couple of surfaces error where others
return `null`) are called out explicitly below.

## Import

`importAsset` (CLI: `hearth import asset <path> [--name n] [--type t]`;
MCP: `import_asset`) copies an external file into `assets/<kind>/` and
registers it in the asset index. The destination kind and asset `type`
are both inferred from the file extension unless you override `type`:

| Extension | `type` |
| --- | --- |
| `png`, `jpg`/`jpeg`, `gif`, `webp`, `svg` | `sprite` |
| `mp3`, `wav`, `ogg`, `m4a` | `audio` |
| `ttf`, `otf`, `woff`, `woff2` | `font` |
| `json` | `data` |
| anything else | `other` |

For `sprite` (and `tile`) assets, import also **probes the image bytes**
for dimensions: no image library, just a byte-level reader
(`packages/core/src/assets/imageInfo.ts`) that understands PNG, JPEG, GIF,
WebP, and SVG (via `width`/`height`/`viewBox` attributes). A successful
probe writes `metadata.width`, `metadata.height`, and `metadata.format`;
an unrecognized or dimensionless file (e.g. a sourceless SVG) just skips
those keys rather than failing the import.

```bash
hearth import asset ./art/walk-sheet.png --name walk-sheet --json
```

```jsonc
{
  "success": true,
  "command": "importAsset",
  "data": {
    "asset": {
      "id": "ast_h22hj7bs",
      "name": "walk-sheet",
      "type": "sprite",
      "path": "assets/sprites/walk-sheet.png",
      "metadata": { "importedFrom": "walk-sheet.png", "width": 64, "height": 16, "format": "png" }
    }
  },
  "errors": [], "warnings": [], "changed": [ /* … */ ], "files": ["hearth.json", "assets.json"], "suggestions": []
}
```

## Bulk import

`importAssets` (CLI: `hearth import asset <path...> [--recursive]`; MCP:
`import_assets`) imports several files in one atomic undo/journal step
instead of one `importAsset` call per file. A single path with no
`--recursive` still runs the single-file `importAsset` command (so
`--name` keeps working); anything else (multiple paths, or a directory
with `--recursive`) expands any directory argument into the files under
it (recursively, dotfiles/dot-directories skipped) and runs `importAssets`
as one batch:

```bash
hearth import asset ./art/tileset/ --recursive --json
```

```jsonc
{
  "success": true,
  "command": "importAssets",
  "data": {
    "imported": [
      { "path": "assets/sprites/grass.png", "assetId": "ast_…", "name": "grass", "type": "sprite" }
      // … one entry per successfully imported file
    ],
    "skipped": [
      { "path": "art/tileset/notes.txt", "code": "UNKNOWN_TYPE", "message": "…" }
    ]
  },
  "errors": [], "warnings": [], "changed": [ /* … */ ],
  "files": ["hearth.json", "assets.json"], "suggestions": []
}
```

Every path is validated up front: a missing file, an unrecognized
extension, or a directory passed without `--recursive` lands in
`skipped` (with a `code` and `message`) rather than failing the whole
batch. Name/path collisions, including two files in the same batch that
would land on the same name, are resolved with an auto-suffix (`grass`,
`grass-2`, …) instead of erroring. `type` (when passed) overrides
extension-based inference for every file in the batch; `--name` is only
valid for the single-file form. The editor's Assets panel funnels both
its multi-select file picker and whole-panel drag-and-drop (including
dropped folders) through this same command. See
[editor.md](./editor.md#bulk-import).

## Slicing a spritesheet

`sliceSpritesheet` (CLI: `hearth create asset slice <asset> --frame-size
WxH [--margin N] [--spacing N] [--prefix NAME]`; MCP: `slice_spritesheet`
with separate `frameWidth`/`frameHeight` numbers instead of a `WxH`
string) cuts an imported sheet into a row-major grid of named frames and
writes them into the asset's own `metadata`. It creates no new asset and no
new file.

| Param | Default | Meaning |
| --- | --- | --- |
| `asset` | — | Sheet asset id or name (must be `sprite` or `tile`) |
| `frameWidth` / `frameHeight` | — | Size of one frame, pixels |
| `margin` | `0` | Border skipped on all four edges before the grid starts |
| `spacing` | `0` | Gap between frames, both axes |
| `namePrefix` | slug of the asset's name | Frame names are `<prefix>_<index>`, row-major (row 0 left-to-right, then row 1, …) |

Worked example: a 64×16 PNG with four 16×16 frames in a single row:

```bash
hearth create asset slice walk-sheet --frame-size 16x16 --prefix walk --json
```

```jsonc
{
  "success": true,
  "command": "sliceSpritesheet",
  "data": {
    "assetId": "ast_h22hj7bs",
    "frameCount": 4,
    "columns": 4,
    "rows": 1,
    "frames": ["walk_0", "walk_1", "walk_2", "walk_3"]
  },
  "errors": [], "warnings": [], "changed": [ /* … */ ], "files": ["hearth.json", "assets.json"],
  "suggestions": ["createAnimationFromSheet --sheet walk-sheet --frames walk_0 walk_1 walk_2 walk_3"]
}
```

`asset.metadata` afterward carries the typed frame list and the grid
that produced it:

```jsonc
{
  "width": 64, "height": 16, "format": "png",
  "frames": [
    { "name": "walk_0", "x": 0,  "y": 0, "width": 16, "height": 16 },
    { "name": "walk_1", "x": 16, "y": 0, "width": 16, "height": 16 },
    { "name": "walk_2", "x": 32, "y": 0, "width": 16, "height": 16 },
    { "name": "walk_3", "x": 48, "y": 0, "width": 16, "height": 16 }
  ],
  "grid": { "frameWidth": 16, "frameHeight": 16, "margin": 0, "spacing": 0 }
}
```

Frame size **must fit** the sheet with the given margin/spacing, or the
command fails outright (`INVALID_INPUT`, both CLI and MCP; there's no
partial slice):

```jsonc
{
  "success": false,
  "errors": [{ "code": "INVALID_INPUT", "message": "Frame size 100×100 does not fit in image 64×16 with margin 0 and spacing 0" }]
}
```

When the frame size doesn't divide the sheet evenly, slicing still
succeeds but leaves a `data.warning` string (not a top-level `warnings[]`
entry; check `data.warning` specifically) naming the unused edge:

```jsonc
{ "data": { "frameCount": 3, "columns": 3, "rows": 1, "frames": [/* … */], "warning": "sheet is 64x16; 4px unused on the right" } }
```

**Re-slicing replaces**: running `sliceSpritesheet` again on the same
asset with different params overwrites `metadata.frames`/`metadata.grid`
wholesale. There's no merge, so any animation referencing frame names
that no longer exist will fail validation (see
[Validation](#validation-of-frame-refs) below).

The only sanctioned reader of `metadata.frames` is
`getSheetFrames(asset)`/`findSheetFrame(asset, name)`
(`packages/core/src/assets/sheetFrames.ts`). Every consumer (renderer,
animator, validator, export bundling) goes through these two functions
rather than reading `metadata.frames` directly, so a malformed or
hand-edited frame list degrades to "no frames" instead of throwing.

## Animations from a sliced sheet

`createAnimationFromSheet` (CLI: `hearth create asset anim-from-sheet
<name> --sheet <asset> --frames a,b,c [--duration SECONDS]
[--no-loop]`; MCP: `create_animation_from_sheet`) builds a `.anim.json`
animation asset whose `frames` array is a list of **sheet refs**
(`"<sheetAssetId>#<frameName>"`) rather than sprite-asset ids. This is
the same animation asset type `createAnimationAsset` produces (still
useful for multi-file sprite flipbooks); a sheet-backed one just points
at named regions of one image instead of N separate files.

```bash
hearth create asset anim-from-sheet walk-cycle --sheet walk-sheet \
  --frames walk_0,walk_1,walk_2,walk_3 --duration 0.12 --json
```

```jsonc
{
  "success": true,
  "command": "createAnimationFromSheet",
  "data": {
    "asset": {
      "id": "ast_1poxkqpa", "name": "walk-cycle", "type": "animation",
      "path": "assets/animations/walk_cycle.anim.json",
      "metadata": { "frameCount": 4, "frameDuration": 0.12, "loop": true, "sheet": "ast_h22hj7bs" }
    },
    "frames": ["ast_h22hj7bs#walk_0", "ast_h22hj7bs#walk_1", "ast_h22hj7bs#walk_2", "ast_h22hj7bs#walk_3"]
  }
}
```

Every frame name must already exist on the sheet (`sliceSpritesheet` run
first): an unknown name fails the whole call (`INVALID_INPUT`, listing
every missing name at once) rather than writing a partially-valid
animation.

Attach it the normal way: add a `SpriteAnimator` with `assetId` set to
the animation asset, and a sibling `SpriteRenderer`. Each fixed frame,
`SpriteAnimator` writes both `SpriteRenderer.assetId` **and**
`SpriteRenderer.frame` from the current entry: a plain sprite-id entry
clears `frame` back to `null` (whole image), a `#`-ref entry sets `frame`
to the frame name. See [components.md](./components.md#spriteanimator)
and [scripting.md](./scripting.md#sprite-animation) for `ctx.animate`.

### Validation of frame refs

`hearth validate` (and `validate_project`) checks two things after any
slicing/animation edit, both **warnings**, not errors: a missing frame
degrades to drawing the whole texture rather than breaking the game:

- `FRAME_NOT_FOUND`: an entity's `SpriteRenderer.frame` names a frame
  that isn't on the referenced sheet.
- `ANIMATION_FRAME_NOT_FOUND`: an animation asset's `<sheet>#<frame>` ref
  doesn't resolve.

At render time the same lookup (`findSheetFrame`) that powers validation
also drives drawing: an unresolvable `SpriteRenderer.frame` logs a
runtime warning once per `assetId#frame` pair and falls back to the
sheet's whole texture, rather than drawing nothing.

## SpriteRenderer.frame and tint

`SpriteRenderer.frame` (default `null`) names a sliced sheet frame to
draw a sub-rectangle of `assetId`'s texture instead of the whole image:
set it directly, or let `SpriteAnimator` drive it. `null` always means
"draw the whole image," even on an asset that has been sliced.

Every textured `SpriteRenderer` (an asset, not the shape/color
primitive fallback) is now tinted by its own `color` field, and a `color`
edit takes effect immediately (it's part of the sprite's visual
identity, so the renderer rebuilds the node with the new tint).
The schema default is `#ffffff` (white), which is a **no-op tint**:
every project that predates this feature renders identically, since an
untouched `SpriteRenderer.color` is still `#ffffff`. Set `color` to
anything else (`#ff8888` for a damage flash, `#888888` to dim) to tint
real art the same way the primitive fallback has always used `color` to
fill its shape.

## Music

### Generating a track (`create music`)

You don't need an imported audio file to have a soundtrack. `hearth create
music` (MCP: `create_music`) synthesizes a deterministic chiptune WAV from
1-4 oscillator tracks and registers it as an `audio` asset, the same way
`create sound` does for one-shot SFX:

```sh
hearth create music theme --tempo 120 --loop \
  --tracks '[{"wave":"square","notes":"C4 E4 G4 - C4 E4 G4 -"},
             {"wave":"triangle","volume":0.4,"notes":"C2 . . . G2 . . ."}]'
```

- `--tempo` is beats per minute (40-300). One `notes` token = one sixteenth
  step, so the step duration is `(60 / tempo) / 4` seconds.
- Each track is `{ wave, volume?, notes }`. `wave` is one of `sine`,
  `square`, `saw`, `triangle`, `noise`; `volume` defaults to `0.6`.
- `notes` is a whitespace-separated token sequence: **note names** in equal
  temperament with `A4 = 440` (`C4`, `F#3`, `Bb2`), `-` for a **rest**, and
  `.` to **extend** the previous note by one more step. Bad tokens fail with
  `INVALID_INPUT`, naming the offending token and track.
- `--loop` (MCP: `loop`) marks the track as looping.
- Pass `--tracks @path/to/song.json` to read the track array from a file
  instead of inline JSON — handy for longer songs.

The WAV lands at `assets/sounds/<slug>.wav` and the asset's `metadata.music`
records `{ tempo, loop, tracks: [{ wave, volume, steps }] }`. Generation is
deterministic: the same params always produce byte-identical audio (noise
uses a seeded PRNG), so committed tracks are reproducible. Wire the returned
asset id to `AudioSource.music` (below) for scene-start autoplay, or play it
from a script with `ctx.audio.playMusic("<asset id or name>")`.

### Playing music at runtime

`ctx.audio.playMusic` / `stopMusic` / `setMusicVolume` are a **separate
channel** from `ctx.audio.play`/`stop`: one shared track for the whole
running game (session-scoped, so it survives `ctx.scenes.load` scene
switches), not a pool of independent one-shot playbacks.

| Call | Signature | Behavior |
| --- | --- | --- |
| `ctx.audio.playMusic` | `(assetRef, opts?: { volume?, loop?, fadeIn? }) -> string \| null` | Replaces whatever is currently playing; returns a handle id, or `null` when the asset doesn't exist |
| `ctx.audio.stopMusic` | `(opts?: { fadeOut? }) -> void` | No-op when nothing is playing |
| `ctx.audio.setMusicVolume` | `(volume, opts?: { fade? }) -> void` | No-op when nothing is playing |

```lua
ctx.audio.playMusic("theme", { loop = true, fadeIn = 1 })
ctx.audio.setMusicVolume(0.3, { fade = 0.5 })
ctx.audio.stopMusic({ fadeOut = 1 })
```

**Replace, not stack**: calling `playMusic` while a track is already
playing doesn't layer the new one on top: the old track is recorded as
stopped (its `fadeOut` equal to the new call's `fadeIn`) and the new one
starts, both ramps running over the same span so the swap crossfades
rather than clicking. `volume` is clamped to `0..1`; `loop` defaults to
`true` (music tracks usually should loop; one-shot SFX via `ctx.audio.play`
default the other way).

**Autoplay**: `AudioSource.music: true` (alongside `autoplay: true`)
routes scene-start autoplay onto the music channel instead of a regular
one-shot/looping playback. Set it on an entity and no script is needed
to start the soundtrack. `music: false` (the default) is the existing
`ctx.audio.play`-style playback.

**In the browser, music streams; it doesn't decode-then-play.** SFX
(`ctx.audio.play`) fetch, fully `decodeAudioData`, and cache the whole
buffer, fine for a two-second sound. Music instead plays through a real
`<audio>` element fed into Web Audio via
`createMediaElementSource`. The browser handles buffering/seeking
progressively, so a five-minute loop never blocks on a full decode.
**Caveat for single-file exports**: `--single-file` embeds every asset as
a `data:` URI baked directly into the HTML text, so by the time the page
loads, the whole track is already in memory regardless: "streaming" in
that build only means "plays through the same `<audio>` element," not
"loads progressively over the network." The folder build
(`hearth export web`, no `--single-file`) is where streaming actually
saves memory and startup time on long tracks.

Run reports record every music play/stop in `audioEvents` with
`music: true`, exactly like one-shot audio does with `music` omitted.
See `assertAudioCount` below. Music never enters the same handle table
`ctx.audio.stop` (SFX) reaches into, so stopping SFX (even every
playback of an asset at once) can never accidentally kill the
soundtrack.

## Fonts

Import a `.ttf`/`.otf`/`.woff`/`.woff2` file (`importAsset`, which infers
`type: 'font'` from the extension) and reference it from `Text.fontFamily`
by **the asset's name, verbatim**. At mount, the browser host
(`packages/runtime/src/pixi/fonts.ts`) loads every font-type asset with
`new FontFace(asset.name, url(...))` and registers it on `document.fonts`
under exactly that name, so there's no CSS `@font-face` block to write
and no guessing at font-family strings. A single font's load failure logs a
warning and does not block the rest (headless Node hosts skip this
entirely; there's no `document`/`FontFace` to touch there, so a
Node-only playtest run never depends on fonts loading).

```bash
hearth import asset ./fonts/press-start-2p.ttf --name press-start-2p --json
hearth set "Title Scene" HUD Text.fontFamily press-start-2p
```

A font asset's name is fixed at import (there is no asset-rename
operation), so choose it deliberately (`--name`): it *is* the
font-family string every `Text` will reference. Need a different name
later? Remove the asset (`removeAsset`) and re-import the file under
the new name, then update each `Text.fontFamily` to match (fontFamily
matches by name, so the old value would otherwise silently fall back
to a system font).

In the editor, `Text.fontFamily` is a picker grouping your project's font
assets with the built-in generic families, not a raw text field. Pick a
project font once it's imported and every `Text` using it re-renders
live in the preview.

## Testing audio: `assertAudioCount`

A playtest step that counts matching entries in the run's `audioEvents`,
filterable by any combination of `asset`, `action` (`play`/`stop`), and
`music` (true/false), checked against `equals`/`min`/`max` (at least one
required):

```jsonc
{ "type": "assertAudioCount", "music": true, "action": "play", "equals": 1 }
```

```bash
hearth create playtest boot --scene "Level 1" --steps-file steps.json --json
hearth playtest boot --json
```

```jsonc
{
  "success": true,
  "data": {
    "passed": true,
    "steps": [
      { "index": 1, "type": "assertAudioCount", "passed": true, "message": "action \"play\", music true count 1 OK" }
    ],
    "audioEvents": [ { "frame": 0, "assetId": "ast_7eo3i5ys", "action": "play", "music": true } ]
  }
}
```

An `asset` filter that doesn't resolve to a real asset fails the step
outright (`assertAudioCount: asset not found: …`) rather than silently
counting zero. A typo'd asset name can't accidentally read as "this
sound never played."

## Agent walkthrough: import to a green playtest

The full loop, CLI-first (every step also has an MCP tool with identical
params: `import_asset`, `slice_spritesheet`, `create_animation_from_sheet`,
`create_entity`, `create_playtest`, `run_playtest`):

```bash
hearth import asset ./art/walk-sheet.png --name walk-sheet --json
hearth create asset slice walk-sheet --frame-size 16x16 --prefix walk --json
hearth create asset anim-from-sheet walk-cycle --sheet walk-sheet \
  --frames walk_0,walk_1,walk_2,walk_3 --duration 0.12 --json

hearth create entity "Level 1" Player \
  --components '{"SpriteRenderer":{},"SpriteAnimator":{"assetId":"walk-cycle","playing":true}}' --json

hearth import asset ./audio/theme.wav --name theme --json
hearth create entity "Level 1" Music \
  --components '{"AudioSource":{"assetId":"theme","autoplay":true,"loop":true,"music":true,"volume":0.6}}' --json

hearth create playtest boot --scene "Level 1" --steps-file steps.json --json
hearth playtest boot --json   # green: passed: true
hearth validate --json         # no FRAME_NOT_FOUND / ANIMATION_FRAME_NOT_FOUND warnings
```

`steps.json` for the last playtest:

```json
[
  { "type": "wait", "frames": 10 },
  { "type": "assertAudioCount", "music": true, "action": "play", "equals": 1 },
  { "type": "assertNoErrors" }
]
```

Over MCP, the same sequence is `import_asset` → `slice_spritesheet` →
`create_animation_from_sheet` → `create_entity` (×2) →
`create_playtest` → `run_playtest`, each call taking the same
parameters shown above (MCP's `slice_spritesheet` takes numeric
`frameWidth`/`frameHeight` instead of the CLI's single `--frame-size
WxH` string; see [mcp.md](./mcp.md)). All of it requires only the
`asset-edit` and `safe-edit` permission modes; nothing here needs
`build`.

See `packages/examples/sky-courier` for a complete, playtested example
built exactly this way: an imported PNG spritesheet sliced into a walk
cycle and idle clip, a streamed WAV music loop on an
`AudioSource.music` entity, and an imported `.ttf` fixture font used by
the HUD text.
