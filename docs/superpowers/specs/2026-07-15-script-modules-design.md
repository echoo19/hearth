# Script modules — shared code between scripts (v1.1.0, Wave N)

Status: approved design, 2026-07-15 (Jake).

## Why

Every Hearth script is an island. Lua nils `require`; JS compiles through
`new Function('module', 'exports', source)` with no resolver. So there is no
way to share a helper between two scripts: an ambitious system (a dungeon
generator, a noise library, a behavior helper used by five enemies) must live
in one oversized script, be copy-pasted, or be routed awkwardly through
`ctx.events`.

This is the ceiling that binds hardest exactly where Hearth's pitch is
strongest — agents getting creative. It bounds *ambitious* work specifically,
which is the work we most want to enable. Code sharing is a bigger creativity
unlock than custom shaders or TypeScript scripts, and cheaper than both.

Goal: a script can `require` another script and use what it returns, in both
languages, with the same determinism, hot-reload, and export guarantees
everything else in Hearth has — and it must read as one coherent system to a
human opening the editor, not just as an agent-facing hook.

## Decisions (locked)

1. **`require('lib/noise')`, resolved against the scripts root.** Not
   `ctx.require` (`ctx` is per-entity runtime state; modules are load-time and
   shared — requiring at module top level must work). Not ESM `import` (needs
   an async module graph, fights the synchronous eval model; still open
   post-1.1 alongside TypeScript scripts, and this design does not foreclose
   it).
2. **Cycles are an error**, not Node-style partial exports. A partially
   initialized module is a determinism hazard and an unreadable failure. The
   error names the full cycle path.
3. **Same-language only.** A `.lua` requires `.lua`; a `.js` requires `.js`.
   Crossing the wasm boundary for arbitrary values is its own project. A
   cross-language require fails with an explicit message, not a confusing
   type error.
4. **Hot-reload invalidation is mandatory.** Editing a library recompiles
   every dependent. The alternative is stale-code-after-edit, the exact bug
   class Wave L spent a ledger on.
5. **Scripts become a tree.** `listScripts()` is flat today, so
   `scripts/lib/noise.lua` is invisible to the loader AND the export bundler.
   Recursive discovery is part of this work — a `lib/` folder is what both a
   human and an agent expect, and without it "modules" means a flat dir of 25
   mixed behaviors and helpers, which is not a cohesive system.
6. **No new asset type.** A library is just a script that returns a table
   (Lua) / exports an object (JS) and happens to have no lifecycle hooks. No
   `LibraryScript` concept, no second picker, no schema change.

## Architecture

### The synchronous-require constraint (the crux)

`require` must be synchronous — that is the entire point of the CJS shape.
But `store.readScript(path)` is async. Therefore **all sources are read
before any script compiles**:

- Phase 1 (async): read every script path's source into a `Map<path, source>`.
- Phase 2 (sync): compile, with `require` resolving purely from that map.

`loadScripts()` already iterates every path and already reads every source —
this is a reordering of existing work, not new I/O. It also means a library is
already loaded and already exported today (both `loadScripts` and
`exportCommands` enumerate `listScripts()`), so **no export work is needed**
beyond recursion.

### Module registry

A `ScriptModuleRegistry` owned by the runtime, holding:

- `sources: Map<path, string>` — phase-1 result.
- `exports: Map<path, unknown>` — memoized module value; a module's top-level
  body runs exactly once per session, on first require.
- `compiling: Set<path>` — cycle detection; a require hitting a member throws
  naming the cycle.
- `dependents: Map<path, Set<path>>` — recorded during compilation (a require
  stack), consumed by hot reload.

**One compile path, or the body runs twice.** `loadScripts()` today compiles
*every* script it finds, attached or not. If a library is compiled once as a
"behavior" and again on first require, its top-level body executes twice —
a silent determinism break. So the registry's `exports` memo must be the
single compile cache: `loadScripts` obtains hooks *through* the registry
rather than calling `compileScript` itself. Eager compilation of unattached
scripts is retained (it is what surfaces a library's syntax errors at load
today, and dropping it would regress error reporting), and memoization makes
it harmless — the body runs exactly once per session whether it is reached
eagerly or by require.

Resolution: `require(spec)` from script at `fromPath` resolves
`scripts/<spec>` with the requiring script's extension inferred when absent
(explicit extension also accepted). The resolved path **must** stay inside the
scripts root — `require('../../secrets')` is rejected. Unresolvable specs
throw naming the attempted path.

### JS

`compileScript(source, require?)` gains a third factory param:
`new Function('module', 'exports', 'require', body)`. Existing behavior is
unchanged when no resolver is passed (keeps `compileScript` usable standalone
and keeps every existing test honest). Note `runtime.ts:235` documents a line
offset for the `new Function` wrapper — adding a param on the same line must
not shift it; verify the error→line mapping still lands.

### Lua

The sandbox currently sets `require = nil` (lua.ts:109). Replace with a shim
bound to the registry, returning the module's returned value as a live Lua
table (staying inside Lua — no userdata-proxy crossing, which sidesteps the
known `type(x) == "userdata"` pitfall entirely). `LuaScriptEngine` needs a
`requireModule(path)` distinct from `compile(path, source)`: the former
returns the module's value, the latter returns `ScriptHooks`.

### Hot reload

`reloadScript(path, source)` today recompiles one script and re-points live
entities. It becomes: update `sources`, invalidate `exports` for `path` **and
every transitive dependent**, recompile them, re-point live entities for each
affected behavior script. A compile failure anywhere leaves the *entire*
previous module graph in place — matching the existing "compile failure keeps
old code running" contract, which must not become "half the graph swapped."

Pinned caveat, documented: re-running a library's top-level body means module
state (a cache built at init, say) resets on reload. `ctx.vars` remains the
place for state that must survive.

## Human-facing surface (not just agents)

- **Code panel / script list**: nested paths render as a tree, not 25 flat
  rows. A script with no lifecycle hooks is labeled a library, so a human can
  tell behaviors from helpers at a glance.
- **Script component picker**: must not offer libraries as attachable
  behaviors — attaching a hookless script silently does nothing today.
- **`checkScript`**: an unresolvable or cyclic require is a lint error with a
  line, surfaced inline in the Code panel like every other diagnostic.
- **`hearth validate`**: a new validation code for a broken require, so the
  CLI/agent path catches it without opening the editor.
- **Errors**: a throw inside a required module reports the *library's* path
  and line, not the requiring script's.

## Testing

- Registry unit: resolution, extension inference, root escape rejection,
  memoization (body runs once), cycle detection message, same-language
  enforcement.
- JS and Lua parity: the same two-script fixture in both languages.
- Hot reload: edit a library → dependents recompile and observe new behavior;
  a library compile error leaves the whole prior graph running.
- Determinism: a seeded run using a required library is bit-identical across
  runs (golden hash), and identical whether the helper is inlined or required.
- Export: a web export of a project with `scripts/lib/*` boots and plays
  (proves recursion reaches the bundler).
- Recursion: `listScripts()` finds nested scripts; existing flat projects are
  unaffected.

## Proof of the whole thing

One example built on it, replacing hand-waving with a real artifact: a
procgen example whose generator lives in `scripts/lib/` (seeded dungeon or
cave generation, shared by two behaviors), with a headless playtest asserting
the generated level is connected at a fixed seed. This exercises modules,
seeded determinism, and the playtest loop together — and doubles as the
"agents can get creative" demonstration. Note `ctx.math` has no noise
primitive; the library hand-writes value noise, which is itself the argument
for modules.

## Non-goals

- ESM `import` / a real module graph (post-1.1, with TypeScript scripts).
- Cross-language require.
- npm / third-party packages. Scripts stay sandboxed and offline; the sandbox
  is a feature, not a gap.
- A `LibraryScript` asset type or schema change.
- Module-level hot state preservation (documented caveat instead).
