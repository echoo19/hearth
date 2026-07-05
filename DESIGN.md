# Hearth Editor — DESIGN.md

Source of truth for tokens: `apps/editor/src/styles.css` (this file
describes it; the CSS defines it).

## Theme

Dark by intent. Game editors are lived-in tools; the scene canvas is the
brightest thing on screen, and colored game content must pop against calm,
ember-tinted neutrals.

## Color (OKLCH throughout)

- Surfaces: `--bg-0` 0.17 (window chrome) → `--bg-1` 0.21 (panels) →
  `--bg-2` 0.25 (inputs/cards/tabs) → `--bg-3` 0.30 (hover); all tinted
  0.008–0.012 chroma toward hue 55 (ember).
- Borders: `--border` 0.32, `--border-strong` 0.42, `--guide` 0.28.
- Ink: `--ink` 0.93, `--ink-mute` 0.74, `--ink-faint` 0.58.
- Accent (ember, actions + selection ONLY): `--accent` oklch(0.74 0.15 55)
  with hover/down/ink/soft/faint variants.
- Status: `--ok` (green 150), `--warn` (yellow 85), `--err` (red 25),
  `--info` (blue 230), each with -soft/-faint alphas where defined.
- Canvas: `--canvas-bg` 0.14, grid lines 0.24/0.34.

## Typography

- UI chrome: Archivo Variable (`--font-ui`), body 13px / 1.45.
- Values, scripts, console, ids: IBM Plex Mono (`--font-mono`), 12px.
- Headings 600 weight, `text-wrap: balance`. No additional families.

## Metrics & Motion

- Control heights: `--ctl-h` 26px, `--ctl-h-sm` 22px — one height per
  control size, everywhere.
- Radii: `--radius` 6px, `--radius-sm` 4px.
- Motion: `--t-fast` 100ms, `--t` 150ms, `--ease-out`
  cubic-bezier(0.25, 1, 0.4, 1); state-conveying only, no decorative
  animation; respect prefers-reduced-motion.
- z-scale (semantic only): dropdown 100 → sticky 200 → modal-backdrop 300 →
  modal 400 → toast 500 → tooltip 600.

## Components (established patterns)

- **Panels**: dockview workspace; panel headers small caps-free labels in
  `--ink-mute`.
- **Inspector fields**: label left, control right; typed controls
  (NumberField, TextField, Vec2Field, Vec2ListField, StringListField,
  color swatch, checkbox toggle, select). Never a raw JSON textarea.
- **Modals**: `--z-modal` over `--z-modal-backdrop` scrim; `--bg-1` body,
  `--border` outline, `--radius`; confirm button uses accent, cancel is
  quiet.
- **Asset cards**: `--bg-2` tiles in a responsive grid
  (`repeat(auto-fit, minmax(...))`), thumbnail over name+type; selection
  ring in accent.
- **Buttons**: primary = accent fill with `--accent-ink` text; secondary =
  `--bg-2` with border; destructive = `--err` styling; all at `--ctl-h`.
- **Console/log rows**: mono font, status color per level.
