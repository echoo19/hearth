# Hearth — Product Context

## Register

Product. Hearth is a desktop app for making games WITH a coding agent: a
conversation on the left, the running game on the right, and a tester that
plays it. The marketing surface lives in the separate hearth-website repo and
does not share this file.

This file described the retired 1.x game engine until 2026-07-28 (scene
editing, asset slicing, a command registry, an Inspector). None of that is the
product. That engine is preserved on the `engine-v1` branch at v1.2.1 and is
not developed. Hearth is not a game engine and must never be called one.

## Users & Purpose

- **Game makers** — hobbyists through indie developers. They describe a game
  and an agent writes it, as plain files in a folder under `~/Hearth`. Hearth
  makes no assumption about what kind of game: no genre, no dimension, no
  engine, no input model. Anything that runs in a browser runs in the pane.
- **Coding agents** — first-class users. Four ways in: an Anthropic key,
  ChatGPT through the open-source Codex CLI, any CLI in the built-in terminal,
  or an agent registered over the stdio protocol in `docs/custom-agents.md`.
  Hearth supplies context and tools; it never molds the agent, and it injects
  no instructions of its own into an agent you brought.
- Primary task on any screen: say what you want, watch it happen, and see the
  game reload beside the conversation.

## Brand Personality

Warm, calm, craftsmanlike. "Kept flame": a serious tool with an ember of
warmth — not corporate, not toy-like. The game pane (the user's game) is
always the brightest, most colorful thing on screen; the chrome recedes.

## Anti-references

- Electron-app blandness (default grays, mismatched control heights).
- Web-dashboard chrome (cards everywhere, hero metrics, gradient accents).
- Engine-vendor maximalism (Unity/Unreal's dense toolbar walls) — Hearth
  stays legible to a newcomer.

## Strategic design principles

1. **Uniform typed controls, never raw JSON** (Jake's bar). Every settings
   field renders as a purpose-built control. If a value can't be edited with a
   typed control, that's a missing control, not a JSON textarea.
2. **Three control heights and no more** (`--ctl-h` 36, `--ctl-h-sm` 30,
   `--ctl-h-xs` 24), one radius scale, one accent (ember) reserved for actions
   and selection. Status colors are semantic only (ok/warn/err/info). A
   hardcoded pixel height is drift; see DESIGN.md.
3. **The user's game is the hero.** App chrome uses calm ember-tinted
   neutrals; the game gets the color.
4. **Never claim more than is known.** The rule the tester is built on, and it
   binds the whole app: never render "there is nothing" when the truth is "we
   have not looked yet", never show a dead end with nothing to press, and never
   imply a guarantee the code does not enforce. An overclaiming tool is worse
   than an absent one, because people act on it.
5. **Accessibility**: keyboard reachable controls, visible focus, contrast
   ≥ 4.5:1 for body text against every surface it lands on, hover and selected
   rows included. `tests/inkContrast.test.ts` computes the real ratios.
6. **Nothing a person typed may be lost.** Drafts survive navigation, chat
   records are on disk before they reach the screen, and the project folder is
   the truth rather than any index.

## Brand assets

`assets/brand/` — "Kept Flame" mark (hearth-mark*.svg). Use it; never invent
new flame art. Fonts: Archivo (UI) + IBM Plex Mono (values/code), shared
with the website so engine and site read as one product.
