# Component Reference

Generated from the Zod schemas in `packages/core/src/schema/components.ts`. Run `hearth inspect components --json` for the machine-readable form.

## Transform

Position (pixels), rotation (degrees), and scale of an entity. Almost every entity needs one.

Defaults:

```json
{
  "position": {
    "x": 0,
    "y": 0
  },
  "rotation": 0,
  "scale": {
    "x": 1,
    "y": 1
  }
}
```

## SpriteRenderer

Renders a sprite asset (assetId) or a colored primitive (shape/color/width/height) when no asset is set.

Defaults:

```json
{
  "assetId": null,
  "shape": "rectangle",
  "color": "#ffffff",
  "width": 32,
  "height": 32,
  "opacity": 1,
  "flipX": false,
  "flipY": false,
  "layer": 0,
  "visible": true
}
```

## Collider

Box or circle collision shape. isTrigger=true reports overlaps without blocking movement.

Defaults:

```json
{
  "shape": "box",
  "width": 32,
  "height": 32,
  "radius": 16,
  "offset": {
    "x": 0,
    "y": 0
  },
  "isTrigger": false
}
```

## PhysicsBody

Simple physics: dynamic bodies fall with gravity and collide; kinematic bodies move by velocity only; static bodies never move.

Defaults:

```json
{
  "bodyType": "dynamic",
  "velocity": {
    "x": 0,
    "y": 0
  },
  "gravityScale": 1,
  "drag": 0
}
```

## Script

Attaches a JavaScript behavior from scripts/ (scriptPath). params are passed to the script as ctx.params.

Defaults:

```json
{
  "scriptPath": "",
  "params": {}
}
```

## Camera

Viewpoint for the scene. One entity should have a Camera with isMain=true.

Defaults:

```json
{
  "zoom": 1,
  "isMain": true,
  "backgroundColor": "#1a1a2e"
}
```

## Text

Renders UI/world text (content, fontSize, color).

Defaults:

```json
{
  "content": "Text",
  "fontSize": 16,
  "color": "#ffffff",
  "align": "left",
  "fontFamily": "monospace",
  "layer": 10,
  "visible": true
}
```

## AudioSource

References an audio asset; autoplay/loop/volume. Playback support is experimental.

Defaults:

```json
{
  "assetId": null,
  "autoplay": false,
  "loop": false,
  "volume": 1
}
```

## Tilemap

Character-grid tilemap: tileAssets maps grid characters to assets; solid=true auto-generates colliders.

Defaults:

```json
{
  "tileSize": 32,
  "tileAssets": {},
  "grid": [],
  "solid": true,
  "layer": -10
}
```

## Notes

- One component of each type per entity (format v1).
- Colors are hex strings (`#rgb`, `#rrggbb`, `#rrggbbaa`).
- Positions/sizes are pixels; rotation is degrees; +y is down.
- `SpriteRenderer` with `assetId: null` draws its primitive `shape`/`color`, so you can build a whole game before any art exists.
