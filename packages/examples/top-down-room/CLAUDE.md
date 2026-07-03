# CLAUDE.md for Top-Down Room

This is a Hearth game project. **Read AGENTS.md for the full agent guide.**

Quick facts:
- Use the `hearth` CLI (with `--json`) for all project operations; do not hand-edit
  `hearth.json`, `scenes/*.scene.json`, or `assets.json`.
- `hearth snapshot` before changes; `hearth validate --json` and `hearth diff` after.
- Behavior code lives in `scripts/*.js`: normal JavaScript, edit freely.
- Test with `hearth playtest <name>` and `hearth run <scene> --frames 120 --json`.
- Never delete assets/scenes without being asked.
