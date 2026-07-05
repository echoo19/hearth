# Hearth — Product Context

## Register

Product. The editor is a lived-in tool: design serves the workflow (scene
editing, asset management, playtesting). The marketing surface lives in the
separate hearth-website repo and does not share this file.

## Users & Purpose

- **Game makers** — hobbyists through indie developers, including the
  Roblox-generation newcomer. They build 2D games in the Hearth editor:
  arranging scenes, importing/slicing assets, writing Lua/JS scripts,
  running playtests.
- **Coding agents** — first-class users of the same engine through CLI/MCP.
  Editor UI must stay a thin adapter over the same command registry; nothing
  the editor does may be un-inspectable or un-scriptable.
- Primary task on any screen: manipulate the game project safely and see the
  result immediately (scene canvas, play mode, asset previews).

## Brand Personality

Warm, calm, craftsmanlike. "Kept flame": a serious tool with an ember of
warmth — not corporate, not toy-like. The scene canvas (the user's game) is
always the brightest, most colorful thing on screen; the chrome recedes.

## Anti-references

- Electron-app blandness (default grays, mismatched control heights).
- Web-dashboard chrome (cards everywhere, hero metrics, gradient accents).
- Engine-vendor maximalism (Unity/Unreal's dense toolbar walls) — Hearth
  stays legible to a newcomer.

## Strategic design principles

1. **Uniform typed controls, never raw JSON** (Jake's bar). Every Inspector
   field renders as a purpose-built control (Vec2ListField, StringListField
   pattern). If a value can't be edited with a typed control, that's a
   missing control, not a JSON textarea.
2. **One control height** (`--ctl-h`/`--ctl-h-sm`), one radius scale, one
   accent (ember) reserved for actions/selection. Status colors are
   semantic only (ok/warn/err/info).
3. **The user's game is the hero.** Editor chrome uses calm ember-tinted
   neutrals; game content and previews get the color.
4. **No engine chrome in shipped games** — nothing the editor adds may leak
   into exports.
5. **Accessibility**: keyboard reachable controls, visible focus, contrast
   ≥ 4.5:1 for body text against panel backgrounds.

## Brand assets

`assets/brand/` — "Kept Flame" mark (hearth-mark*.svg). Use it; never invent
new flame art. Fonts: Archivo (UI) + IBM Plex Mono (values/code), shared
with the website so engine and site read as one product.
