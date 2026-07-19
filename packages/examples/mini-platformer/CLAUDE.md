# CLAUDE.md for Mini Platformer

This is a Hearth game project. **Read AGENTS.md for the full agent guide.**

Start of session (don't relearn the project every time):
- Read `.hearth/digest.md` — the engine's always-current snapshot of scenes,
  entities, scripts, and assets. Trust it instead of re-running `inspect` on
  everything; inspect one entity only when you need its full component data.
- `hearth recall` — durable decisions/todos/gotchas from past sessions. Record
  new ones with `hearth remember "<note>" --section decision|todo|gotcha`.

Quick facts:
- Use the `hearth` CLI (with `--json`) for all project operations; do not hand-edit
  `hearth.json`, `scenes/*.scene.json`, or `assets.json`.
- `hearth snapshot` before changes; `hearth validate --json` and `hearth diff` after.
- Behavior code lives in `scripts/`: **Lua by default** (`.js` also supported), edit freely.
  Lua calls ctx with a dot, not a colon: `ctx.log("hi")`. `hearth inspect api --json`
  documents the full ctx API — read it when scripting rather than from memory.
- Test with `hearth playtest <name>` and `hearth run <scene> --frames 120 --json`
  (run reports include `audioEvents` for checking sound behavior).
- **See your work:** `hearth screenshot <scene>` renders a PNG — no build permission
  needed. Read it back to check layout before calling anything done.
- **Building or polishing a game?** Use the `hearth-craft` skill (animation, juice,
  game-feel, quality bar). Flat placeholder rectangles and static scenes are not
  "done" — animate, add feel, and screenshot to confirm.
- `hearth create sound <name> --preset coin` makes procedural sound effects;
  `hearth export web [--single-file] [--zip]` makes a playable web build (needs build permission).
- Never delete assets/scenes without being asked.
