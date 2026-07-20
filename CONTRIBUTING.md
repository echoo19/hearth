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

## Reporting bugs and requesting features

[GitHub Issues](https://github.com/echoo19/hearth/issues) is the real tracker.
If you have a GitHub account, use it: the report is public, other people can
find it, and you can follow what happens to it.

If you'd rather not open a GitHub account, the
[feedback form](https://hearthengine.com/feedback) works too. Be clear
about the tradeoff: it sends a private message to the maintainer rather than
filing a public issue, so there's nothing for you to track and nobody else can
see it or add to it. It still gets read.

Either way, include your OS, the Hearth version, and what you expected to
happen instead.

## Dev setup

```bash
git clone https://github.com/echoo19/hearth.git && cd hearth
npm install
npm run build:packages   # core → runtime → playtest → shipping → templates → cli → mcp-server
npm test                 # vitest across all packages
npm run typecheck        # tsc across all packages
npm run dev              # editor at http://localhost:5173
```

- Node ≥ 20. TypeScript, ESM, NodeNext resolution (relative imports need
  `.js` extensions).
- **Run `npm run typecheck` as well as `npm test`.** Vitest runs against
  sources without typechecking them, so a green suite can still ship a broken
  TypeScript build. It has happened. CI checks both, so check both locally.
- Tests run against package **sources** via vitest aliases, so you don't
  need to rebuild while iterating (`npm run test:watch`).
- Regenerate example projects after command-system changes:
  `node packages/examples/generate.mjs`. CI regenerates them too and fails if
  the result isn't byte-identical to what you committed.

## Project map

See [docs/architecture.md](docs/architecture.md). Quick version: `core` owns
schemas/commands/validation/diff; `runtime` simulates and renders;
`playtest` runs headless tests; `cli` and `mcp-server` are thin adapters;
`apps/editor` is the human surface.

## AI / agent contribution policy

Hearth is an agent-native engine, and AI-assisted contributions are welcome,
held to the same standard as any other contribution:

- **You must understand the change.** If a maintainer asks "why is this
  loop bounded here?", "explain it" is part of the contribution.
- Include tests where appropriate, and run the suite before opening the PR.
- Disclose substantial AI assistance in the PR description (a line like
  "drafted with Claude Code, reviewed and tested by me" is plenty).
- **Autonomous drive-by AI PRs are not accepted.** Mass-generated changes
  with no human who can answer for them will be closed without review.
- Agents contributing *to game projects built with Hearth* should follow the
  generated `AGENTS.md` in those projects; this policy is about the engine
  repo itself.

## Style

- Match the surrounding code: 2-space indent, single quotes, JSDoc header
  comment per file explaining the module's role.
- No new runtime dependencies without discussion; the dependency budget is
  deliberately tiny (zod, commander, pixi, react, wasmoon, MCP SDK).
- Error messages should tell the reader what to do next, beyond what broke
  (see `ProjectError` usages for tone).

## Releases

Hearth is at v1.0.0, the production release; it is no longer a developer
preview. Versioning is synchronized across packages, and releases are
automated: pushing a `v*` tag builds the desktop app for macOS, Windows, and
Linux, and publishes those alongside the standalone `hearth-cli.mjs` and
`hearth-mcp.mjs` as release assets.
