# Contributing to Hearth

Thanks for wanting to make the hearth warmer. This project is young; issues,
design discussions, docs fixes, and code are all welcome.

## Ground rules

- Be kind. Assume good intent; review the code, not the person.
- Small, focused PRs merge fastest. Open an issue first for anything large.
- Every behavior change needs tests (`npm test`) and, if it touches the
  project format or command system, doc updates (`docs/`).
- Keep the architecture boundary sacred: **all project mutations go through
  the core command system.** If your feature edits project files any other
  way, it will be asked to change.

## Dev setup

```bash
git clone <repo> && cd hearth
npm install
npm run build:packages   # core → runtime → playtest → cli → mcp-server
npm test                 # vitest across all packages
npm run dev              # editor at http://localhost:5173
```

- Node ≥ 20. TypeScript, ESM, NodeNext resolution (relative imports need
  `.js` extensions).
- Tests run against package **sources** via vitest aliases — no rebuild
  needed while iterating (`npm run test:watch`).
- Regenerate example projects after command-system changes:
  `node packages/examples/generate.mjs`.

## Project map

See [docs/architecture.md](docs/architecture.md). Quick version: `core` owns
schemas/commands/validation/diff; `runtime` simulates and renders;
`playtest` runs headless tests; `cli` and `mcp-server` are thin adapters;
`apps/editor` is the human surface.

## AI / agent contribution policy

Hearth is an agent-native engine, and AI-assisted contributions are welcome —
under the same standard as any contribution:

- **You must understand the change.** If a maintainer asks "why is this
  loop bounded here?", "explain it" is part of the contribution.
- Include tests where appropriate, and run the suite before opening the PR.
- Disclose substantial AI assistance in the PR description (a line like
  "drafted with Claude Code, reviewed and tested by me" is plenty).
- **Autonomous drive-by AI PRs are not accepted** — mass-generated changes
  with no human who can answer for them will be closed without review.
- Agents contributing *to game projects built with Hearth* should follow the
  generated `AGENTS.md` in those projects; this policy is about the engine
  repo itself.

## Style

- Match the surrounding code: 2-space indent, single quotes, JSDoc header
  comment per file explaining the module's role.
- No new runtime dependencies without discussion — the dependency budget is
  deliberately tiny (zod, commander, pixi, react, MCP SDK).
- Error messages should tell the reader what to do next, not just what broke
  (see `ProjectError` usages for tone).

## Releases

v0.1.x is a developer preview. Versioning is synchronized across packages;
release automation is on the roadmap.
