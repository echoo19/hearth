# Wave L2 — Agent Game-Craft (mini-wave)

Date: 2026-07-14 · Status: Approved via Jake's standing order (steers 4–10, recorded in .superpowers/sdd/progress.md)
Predecessor: Wave L v0.14.0 (tightening). Successor: Wave M (final hardening/verification).

## Goal
Agents don't just know HOW to operate Hearth (Wave L's skill) — they know how
to make GOOD games with it, can connect from any agent stack including local
models, and the docs/website present Hearth as one comprehensive AI-native
tool. No engine features. NO full game builds (Jake runs that himself later).

## Tracks
1. **Craft skill** (`skills/hearth-craft/SKILL.md`, distributed like the
   mechanics skill — embedded in core, scaffolded to `.claude/skills/`,
   backfilled on agent prepare): game-feel recipes as concrete ctx/CLI code
   (juice: hit-stop, screen shake on impact, particle bursts + layered
   createSound, tween easing, ASM idioms), palette/tile-size discipline,
   game-UX conventions (menus/pause/settings via scenes, onboarding,
   difficulty curves, feedback-on-every-interaction, save/load etiquette),
   and a **quality-bar checklist** an agent runs before calling a game done.
   Every recipe references real APIs (accuracy-tested like skillAccuracy).
2. **Asset sourcing playbook** (section of the craft skill + docs page):
   where to find 2D assets autonomously — Kenney, itch.io CC0, OpenGameArt,
   Freesound, Google Fonts/OFL — for characters, tilemaps, UI buttons,
   audio; licensing rules (prefer CC0; attribution handling); the
   fetch → `hearth import` → screenshot-verify loop. Sources fact-checked
   live (URLs valid, licenses as claimed) at authoring time.
3. **Zero-gap agent connectability** (editor/server): Agent-panel launcher
   parity — detect/prepare/launch for Claude Code (exists), Codex,
   OpenCode (incl. Ollama local models), Hermes, generic CLI; hearth CLI
   guaranteed on PATH in the embedded terminal; MCP config written per
   tool's format; skill presence ensured; already-configured detection (no
   double-writes). Verification: config-shape tests + PTY launch of
   available CLIs; local-model loop proof only if Ollama is present —
   otherwise documented honestly (no synthetic claims).
4. **Docs wiki restructure + guides** (website): journey-grouped IA
   (Get started / Build / Script / Ship / Agents / Reference); per-agent
   connect guides (Claude Code, Codex, OpenCode+Ollama, Hermes, generic
   MCP/CLI page with per-tool config formats); ship-it destination guides
   (itch.io, static host/own site, downloadable desktop incl.
   Gatekeeper/SmartScreen honesty). Engine-repo markdown stays source of
   truth; sync pipeline preserved.
5. **README rewrite + AI-native positioning**: README = basics → coding
   with your agent in minutes. Website language site-wide reads
   "AI-native game engine" — the knowledge layer (skills, verification
   loop, journal review, determinism) is the story; MCP/CLI is plumbing
   (memory: ai-native-positioning). No example showcase (standing rule).

## Constraints
- Anti-bloat binding; no new engine commands unless a connectability gap
  literally requires one (then smallest-possible, parity-complete).
- No full agent game builds (steer 9). Recipe spot-checks only.
- Editor stays dark-locked, ember accents; website stays Wave-K design
  system — language/IA changes, not visual redesign.
- Ships as v0.15.0 if editor/server code changes land (track 3), else
  docs/site-only release; decide at gate.

## Verification
- Craft-skill accuracy test (APIs referenced exist); sourcing URLs checked
  live at authoring; per-recipe spot-checks in a scratch project (assert
  the recipe compiles/runs via playtest, not that the game is "good").
- Track 3: detection/prepare matrix tests; live PTY launch for each CLI
  present on this machine; honest NOT-TESTED notes for absent ones.
- Website: build green, live-verify IA + guides + positioning sweep;
  Lighthouse not regressed on homepage.
- Final: fable gate (content accuracy + positioning + connectability
  matrix), then ship.
