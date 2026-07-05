# CLAUDE.md for Sky Courier

This is a Hearth game project. **Read AGENTS.md for the full agent guide.**

Quick facts:
- Use the `hearth` CLI (with `--json`) for all project operations; do not hand-edit
  `hearth.json`, `scenes/*.scene.json`, or `assets.json`.
- `hearth snapshot` before changes; `hearth validate --json` and `hearth diff` after.
- Behavior code lives in `scripts/`: **Lua by default** (`.js` also supported), edit freely.
  Lua calls ctx with a dot, not a colon: `ctx.log("hi")`. `hearth inspect api --json`
  documents the full ctx API.
- Test with `hearth playtest <name>` and `hearth run <scene> --frames 120 --json`
  (run reports include `audioEvents` for checking sound behavior).
- `hearth create sound <name> --preset coin` makes procedural sound effects;
  `hearth export web [--single-file] [--zip]` makes a playable web build (needs build permission).
- Never delete assets/scenes without being asked.
