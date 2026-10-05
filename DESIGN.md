# Hearth Editor — DESIGN.md

Source of truth for tokens: `apps/editor/src/styles.css` (this file
describes it; the CSS defines it).

## Theme

Dark by intent, in Lectern's design language (the sibling product at
`~/projects/lectern`; its canon lives in `lectern-archive/design/`). True
dark: a near-black rail, warm surfaces raised a few steps off it, a cool grey
text ramp, hairlines rather than boxes. The user's game is the brightest, most
colourful thing on screen; the chrome recedes. Ember is Hearth's one
per-brand variable, exactly as the accent is in Lectern's canon.

## Color (OKLCH throughout)

- Surfaces, warm hue 85, chroma under 0.006: `--bg-0` L0.13 (rail, window
  chrome) → `--bg-05` L0.155 (main content) → `--bg-1` L0.183 (raised:
  panels, popovers, dialogs) → `--bg-2` L0.212 (inputs, composer, user
  bubbles) → `--bg-3` L0.251 (hover).
- Lines sit lighter than the surfaces they divide: `--hairline` L0.21,
  `--guide` L0.24, `--border` L0.29, `--border-strong` L0.40.
- Ink, cool hue 286: `--ink` L0.97, `--ink-mute` L0.776, `--ink-faint`
  L0.692, and `--ink-ghost` L0.519, which is for non-text only.
- The current row in any list is `--rail-current` (a raised surface) plus
  `--rail-current-edge` (an inset hairline). It is never an accent tint; the
  accent is spent on the row's glyph alone.
- Accent (ember: primary actions, current selection, live state ONLY):
  `--accent` `oklch(0.684 0.192 42)`, with `--accent-hover`, `--accent-down`,
  `--accent-ink`, `--accent-soft`, and `--accent-faint`.
- Status: `--ok`, `--warn`, `--err`, `--info`, each with soft alphas.
- Game pane: `--canvas-bg` L0.11. `--overlay-bg` is near-opaque, never
  blurred. `--scrim` is black at 0.62. `--flame-brand` (`#f76b15`) is the
  wordmark flame, a brand mark rather than a UI colour.

## Typography

Lectern's three registers, one job each:

- **Plus Jakarta Sans** (`--font-ui`) carries every voice that carries
  meaning: chrome, the conversation, buttons, headings. The display voice
  (`--font-display`) is the same face at 600 with `--track-tight`, used only
  on the brand moments listed in `tests/styleGates.test.ts`.
- **Space Grotesk** (`--font-caption`) is the caption register, in NORMAL
  caps (`.eyebrow`): the rail's group headings, settings nav titles and menu
  group headers. It is never a kicker above sections.
- **JetBrains Mono** (`--font-mono`) is for values only: paths, ids, code,
  console, and numerals that tick.

No uppercase tracked micro-labels. Chrome is 13px; the conversation reads at
15px.

## The bar (from Lectern's canon)

- No eyebrows above sections, no decorative pills or badges, no gradients,
  no glows, no glass. State is plain text, a solid token dot, or nothing.
- Nothing loops on its own. The one exception is the flame, while an agent
  turn is actually in flight; it is a progress indicator and goes still the
  moment work ends.
- A provider's own mark (Claude, OpenAI) beats a text chip for "who
  answers". See `components/settings/providerLogos.tsx`.
- Uncluttered but functional: a control that is always there earns a border
  only when it is the primary act. Pickers in the composer are borderless
  until hovered.

## Metrics & Motion

- Control heights: three tiers and no more. `--ctl-h` 34px is the default
  control and the icon-button square; `--ctl-h-sm` 28px is the compact
  variant for dense secondary rows; `--ctl-h-xs` 24px is the quiet square
  that sits inside a list row, such as the overflow dots on a conversation.
  24px is a floor, not a suggestion: it is the smallest target WCAG 2.2
  accepts, and under it a control becomes something you aim at twice.
  Hardcoding a pixel height rather than naming a tier is drift, and it is how
  the same control ended up three different sizes on three surfaces.
- Radii, Lectern's scale: `--radius-xs` 4px, `--radius-sm` 6px (compact
  controls), `--radius` 8px (controls), `--radius-lg` 12px (menus, modals,
  cards), and `--radius-xl` 16px (the composer alone). Round buttons (Send)
  are `50%` by design and exempt.
- Colour is checked, not eyeballed. `--ink-faint` is the quietest text the
  app has, and it has to clear 4.5:1 on every surface it lands on, including
  hover and a selected row, which is where it failed. `tests/inkContrast.ts`
  computes the real ratios from the tokens, so retuning a surface is safe and
  a regression is loud.
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
- **Modals**: `--z-modal` over `--z-modal-backdrop` scrim (`--scrim`);
  `--bg-1` body, `--border-strong` outline, `--radius-lg`; confirm button
  uses accent, cancel is quiet.
- **Asset cards**: `--bg-2` tiles in a responsive grid
  (`repeat(auto-fit, minmax(...))`), thumbnail over name+type; selection
  ring in accent.
- **Buttons**: primary = accent fill with `--accent-ink` text; secondary =
  `--bg-2` with border; destructive = `--err` styling; all at `--ctl-h`.
- **Console/log rows**: mono font, status color per level. A row that names an
  exact script location renders a trailing **console link** (`.console-link`):
  a real `<button>`, mono 11px, `--ink-faint` at rest → `--accent` (underlined)
  on hover, that opens the script at that line. Focus ring from the global
  `:focus-visible` rule; never inline-styled.
- **Tab strip in a panel** (`.code-tabs`): a `--bg-2` strip of tabs, each a
  presentation **cell** holding two sibling `<button>`s — the tab
  (`role="tab"`, roving `tabindex`, arrow/Home/End nav) and its close control
  (never nested inside the tab, to avoid a nested-interactive widget). Active
  tab: `--bg-1` fill plus the shared 2px `--accent` underline idiom
  (`.hearth-tab::after`), driven by `aria-selected`. Dirty = an `--accent`
  dot; changed-outside-the-editor = a `--warn` dot. The close control is
  opacity-0 until the cell is hovered/active or the button is focused.
- **Status dot** (`.ws-dot`): an 8px round connection indicator — `--ok`
  connected, `--err` down, `--warn` with a soft opacity pulse while
  reconnecting (flattened under reduced-motion). Status only:
  `role="status"` + `aria-label`, never focusable.
