---
name: hearth-art
description: Give a Hearth game real art and sound — importing and slicing spritesheets, animations, procedural sprites and sounds, autonomous CC0 asset sourcing (Kenney, itch.io, OpenGameArt, Freesound, Google Fonts) with licensing rules, and pixel-art discipline (never stretch; read the art before using it). Use when the game needs to look or sound like something, including choosing, downloading, and verifying assets.
---

# Art and sound in Hearth

This skill covers making the game look and sound real — sourcing, importing,
and using assets correctly. Where tiles get *painted* (tilemaps, autotile
binding) is the `hearth-build` skill; layered-sound design and juice are
`hearth-feel`; the operating loop (snapshot → change → validate → playtest) is
the core `hearth` skill.

## Assets: import, slice, animate, sound

```bash
hearth import asset ./art/walk-sheet.png --name walk-sheet --json
hearth import asset ./art/tileset/ --recursive --json          # atomic batch; check data.skipped
hearth create asset sprite hero --shape rectangle --color "#f4a460" --width 24 --height 24
hearth create asset slice walk-sheet --frame-size 16x16 --prefix walk --json
hearth create asset anim-from-sheet walk-cycle --sheet walk-sheet --frames walk_0,walk_1,walk_2,walk_3 --duration 0.12 --json
hearth create animation blink --frames sprite-a sprite-b --frame-duration 0.4    # multi-file flipbook
hearth create sound pickup --preset coin                       # presets: coin jump hit laser powerup explosion blip
```

Procedural sprites/sounds make a game playable and audible before real art
exists. Fonts: import a `.ttf/.otf/.woff` and reference it from `Text.fontFamily`
by the asset's **name** verbatim. Music is a separate channel — set
`AudioSource.music:true, autoplay:true` for a soundtrack that survives scene
switches. Full pipeline: [docs/assets.md](https://hearthengine.com/docs/assets).

## Never stretch pixel art — tile or slice it

A `SpriteRenderer` fills its `width`×`height` box one of three ways, set by
`renderMode` (default `stretch`):

- `stretch` — scales one texture to the box. **Only correct when the box keeps
  the texture's own aspect ratio at a whole-number scale** (e.g. an 18×18 tile
  at 18×18, 36×36, 54×54). Any other size *distorts* the art — a smear.
- `tile` — repeats the texture at its **native pixel size** to fill the box.
  This is how a wide platform/floor/wall built from one small tile should
  render: connected tiles, no smear. `hearth set "Level 1" Ground SpriteRenderer.renderMode tile`.
- `sliced` — 9-slice: `slice` insets (`{top,right,bottom,left}` px) keep the
  corners un-stretched while edges/center scale. For panels, bars, and
  platforms with distinct end-caps.

Firm rules for surfaces and pixel art:

1. **Never** make a wide/tall surface by stretching a single small tile in
   `stretch` mode. Use a `Tilemap` (best for grids/terrain, supports
   autotiling) or `renderMode: 'tile'`.
2. In `stretch` mode use **integer** scales only, and keep the box aspect equal
   to the texture's — otherwise texels go rectangular/blurry. `hearth validate`
   flags violations as `PIXEL_ART_STRETCHED`; fix every one.
3. **Snap positions and sizes to the tile grid** so neighbouring tiles connect
   with no gaps, seams, or overlaps.
4. Pixel art stays crisp automatically: projects render with
   `buildSettings.pixelPerfect: true` (NEAREST filtering) by default. Leave it
   on for pixel art; a single non-pixel asset can opt out with its own
   `pixelArt: false`.

## Asset sourcing playbook

You can source real 2D art, audio, and fonts autonomously. **Ask the human
first, in one line** ("Pull Kenney's platformer pack, CC0?") — then source
freely within what they approved. **Licensing is not optional** — a
mis-licensed asset is a shipping blocker, not a detail.

### Mandatory pack intake: source → inspect → vision → contract → proof

Do this before importing any unfamiliar local or online asset pack:

1. **Source and provenance.** For an online pack, use the pack's listing page,
   get download approval, record the exact source URL, author, and license, and
   download the complete pack. Preserve unchanged vendor files in the downloaded pack;
   put crops, conversions, and renamed working copies elsewhere. A missing or
   unclear license is a hard stop.
2. **Inspect before import.** Run
   `hearth inspect asset-pack ./downloads/pack --source-url URL --author NAME --license SPDX --json`
   or MCP `inspect_asset_pack`. Read every diagnostic, the ordered
   `reviewImages`, README/license evidence, image dimensions, and TMX/TSX/Tiled
   metadata before choosing files. A contact sheet is an aid, not a substitute
   for the source metadata.
3. **Use authored evidence.** Inspect authored sample or example TMX/Tiled maps
   and their TSX/Tiled metadata. They show intended layer order, tile
   adjacency, anchors, terrain rules, and collision semantics. Do not guess
   adjacency or neighbour rules from loose tiles, filenames, or atlas indices.
4. **Visual review with vision.** Read the reported `reviewImages` (or generated
   contact sheet) and compare them with vendor screenshots. Keep **engine facts**
   separate from **vision**. Mark each placement decision as:
   **exact** (explicit metadata), **corroborated** (metadata plus visual
   agreement), **inferred** (visual evidence only), or **unknown**. Never turn
   inferred/unknown adjacency, anchors, collision, or frame roles into facts.
   An inferred standalone visual may be tried only in the proving ground.
5. **Write the art contract.** Record logical grid footprint, sprite rectangle,
   anchor/feet point, projection, authored layer stack, palette/value range,
   outline weight, light direction, shadow style, filtering, and pixel density.
6. **Prove it.** Import only a representative subset and build a visual proving ground:
   every transition/corner, representative walls and oversized props,
   actor front/behind checks, and collision. Capture it at gameplay zoom and
   compare it with the vendor reference before production placement.

`PACK_ISOMETRIC_UNSUPPORTED`, unsupported depth/occlusion, tile flips, object
layers, offsets, collision, or terrain diagnostics are not invitations to
flatten the map. Stop, use a supported representation, or ask the human to
approve a different pack/scope.

### Where to look (verified July 2026)

| Source | URL | License | Attribution | Notes |
| --- | --- | --- | --- | --- |
| **Kenney** | https://kenney.nl/assets | CC0 (public domain) | Not required (credit "Kenney" if you like) | The default first stop. Cohesive 2D sprite/tile/UI/audio packs, all CC0. |
| **itch.io CC0** | https://itch.io/game-assets/assets-cc0 | CC0 v1.0 | Not required | 2,600+ packs; filter by tag (Sprites, Tileset, Pixel Art). Use the `/free` and CC0 filter — do **not** assume a random itch asset is CC0. |
| **OpenGameArt** | https://opengameart.org | **Varies**: CC0, OGA-BY, CC-BY, CC-BY-SA, GPL, WTFPL | Depends on the license | Per-submission license — **read each asset's license box**. Filter search by license; prefer CC0/CC-BY. |
| **Freesound** | https://freesound.org | **Varies**: CC0, CC-BY, CC-BY-NC | Depends; NC blocks commercial | Login required to download. Filter to "Free Cultural Works" (CC0 + CC-BY). Avoid CC-BY-NC unless the game is truly non-commercial. |
| **Google Fonts** | https://fonts.google.com | ~99% OFL, ~1% Apache-2.0 | Not required | Free commercial, embeddable/bundlable in a game. Keep the `OFL.txt` next to the font file. |

### Licensing rules (follow every time)

1. **Prefer CC0.** No attribution, no strings, safe to modify and ship. Kenney and
   the itch.io CC0 filter are the fastest CC0 firehoses.
2. **CC-BY / OGA-BY / OFL → attribution required.** Keep a `CREDITS.md` in the
   project listing asset, author, source URL, and license for each. Add it as you
   import, not at the end.
3. **Never use CC-BY-NC / CC-BY-SA / GPL** in anything that might ship
   commercially without confirming with the human — NC bans commercial use, SA/GPL
   force your whole project's license. When unsure, ask.
4. **Never rip unlicensed assets** — no scraping game rips, stock sites, or
   "found on Google Images". If you can't name the license, don't use the asset.
5. **Record the provenance at import time.** URL + license in `CREDITS.md` for
   every non-CC0 asset (and it's polite for CC0 too).

### The fetch → inspect → import → verify loop

Download, inspect the whole pack, **look at the art**, import through the
pipeline (never drop files into `assets/` by hand), then *look again* with a
screenshot before trusting it.

```bash
# 1. Fetch (plain shell — curl/wget; respect the site's terms).
curl -L -o downloads/kenney-platformer.zip https://kenney.nl/media/pages/assets/.../platformer-pack.zip
unzip downloads/kenney-platformer.zip -d downloads/kenney-platformer

# 2. INSPECT metadata, then READ the reported images before using them.
hearth inspect asset-pack ./downloads/kenney-platformer \
  --source-url https://kenney.nl/assets/... --author Kenney --license CC0-1.0 --json
#    Know what each
#    tile/frame actually depicts — pick art by appearance, never by filename
#    or frame index. A lever is a switch, not a spike; spikes are hazards.
#    Getting this wrong reads as a broken game even when the code is right.

# 3. Import only after inspection (schema-validated; batch import is atomic).
hearth import asset ./downloads/kenney-platformer/PNG/Tiles/ --recursive --json   # check data.skipped
hearth import asset ./downloads/hero.png --name hero --json

# 4. Slice a sheet into frames NAMED FOR WHAT THEY DEPICT, then build a clip.
hearth create asset slice hero --frame-size 16x16 --prefix hero --json
hearth create asset anim-from-sheet hero-walk --sheet hero --frames hero_0,hero_1,hero_2,hero_3 --duration 0.12 --json

# 5. Fonts: import the .ttf/.otf, reference by the asset NAME from Text.fontFamily.
hearth import asset ./downloads/PressStart2P.ttf --name press-start-2p --json

# 6. VERIFY — put it in a scene and screenshot it back. Don't trust unseen art.
hearth screenshot "Level 1" --frame 10 --out shots/art-check.png
```

Read the PNG back and confirm the art is the size, palette, and alignment you
expected — imported sheets often need a different `--frame-size`, and a
transparent-background PNG can hide misalignment until you look.

## Pixel-art sizing and palette discipline

- **Pick one logical cell footprint and hold it.** Match `Tilemap.tileSize` to
  the authored grid (for example 16×16 or 32×32). The sprite rectangle is a
  separate fact: a 32px cell may legitimately have a 32×64 wall or tree drawn
  above it. Keep that art intact and bottom-align its footprint/feet point; do
  not crop or squash oversized sprites to cell height. Mixing unrelated pixel
  densities still reads as amateur.
- **Integer scale only.** Display pixel art at 1×, 2×, 3× — never 1.5×, or it
  smears. Size sprites/build resolution so scaling stays integer. `hearth
  validate` flags every violation as `PIXEL_ART_STRETCHED` — fix them all before
  calling art done.
- **Never stretch a tile into a surface.** A wide platform, floor, or wall is
  *not* one small tile scaled up in a `SpriteRenderer` — that smears the texels
  into a blur. Build surfaces from a `Tilemap` (grids/terrain, supports
  autotiling) or set `SpriteRenderer.renderMode: 'tile'` so the texture repeats
  at its native size. For panels/bars with distinct end-caps use
  `renderMode: 'sliced'` with `slice` insets so the corners stay un-stretched.
  Snap every tile to the grid so neighbours connect with no gaps or overlaps.
- **Make surfaces connect from evidence — never repeat one tile.** A cohesive platform, floor,
  wall, or structure uses a **connective tileset**: edge, corner, interior, and
  end-cap tiles chosen by their neighbours. Reproduce the pack's authored
  sample map/layers, use a genuine blob47 rule, or use a deliberate
  left-cap/middle/right-cap (top/mid/bottom) choice backed by exact evidence.
  A single tile repeated with autotile OFF, or a row of individual
  one-tile `SpriteRenderer` entities, reads as disconnected mismatched blocks
  each with its own outline — not one object. This is the line between "tiles
  that render" and "a surface that looks real." (Painting and binding the
  tileset is the `hearth-build` skill.)
- **Crisp by default.** `buildSettings.pixelPerfect: true` (the default) renders
  every texture with NEAREST filtering — leave it on for pixel art. Only a
  genuinely non-pixel asset (a photo, a soft gradient) should opt out via its
  own `pixelArt: false`.
- **Constrain the palette.** A cohesive game uses a limited, shared palette
  (Kenney packs and most CC0 pixel packs already are). Don't mix a 40-color
  painterly sprite with an 8-color pixel tileset. When generating procedural
  placeholders, pull from the same handful of hexes as the imported art.
- **Placeholders are fine, mismatched art is not.** Procedural
  `hearth create asset sprite` shapes (rectangle/circle/character/coin/star/…)
  keep the game playable before real art lands — swap them for imported art of
  the *same size and palette family* later.
