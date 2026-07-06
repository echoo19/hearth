# Wave E: Agent Panel + Content Scale Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.8.0: an embedded agent terminal panel (PTY running the user's own Claude Code, live trust timeline, external-change awareness) plus content-scale work (bench harness with published numbers, bit-identical broadphase/caching/pooling, scene management/templating end to end, tilemap paint tooling, Ember Horde example).

**Architecture:** A disk-backed command journal appended in `HearthSession.execute` becomes both the agent trust timeline and the editor's external-change signal (watched server-side, pushed over a new multiplexed WebSocket that also carries PTY frames). The agent panel embeds `@lydell/node-pty` + `@xterm/xterm` running the genuine `claude` CLI (subscription-safe; we never touch its stream). Perf work is pure pruning/caching guarded by golden determinism tests against a naive reference. Scene/tilemap commands follow the existing defineCommand → registry → CLI verb → MCP ToolSpec parity pattern.

**Tech Stack:** TypeScript ESM NodeNext, zod, vitest, commander, MCP SDK, ws, @lydell/node-pty, @xterm/xterm, React + zustand + dockview, PixiJS, Electron 33 / electron-builder.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-06-waveE-agent-panel-scale-design.md`. Where this plan and the spec conflict, stop and escalate.
- Every mutation flows through `HearthSession.execute` (packages/core/src/session.ts). CLI, MCP, editor are thin adapters — never bypass the registry.
- CLI/MCP parity: every new core command gets a CLI verb in `packages/cli/src/program.ts` AND a ToolSpec in `packages/mcp-server/src/tools.ts` (snake_case name, mirrored zod inputShape) in the same wave.
- Perf changes must be **bit-identical**: golden determinism tests compare full-run state hashes against the naive reference; no RNG stream may be read by new code; pair resolution order preserved exactly (movers in entity order; per mover, obstacles in ascending collection index; mover pairs ascending (i,j), i<j).
- Journal/PTY failures never fail a command or crash the editor: isolated try/catch + warning, matching the Wave D history-capture pattern (session.ts HISTORY_RECORD_FAILED precedent).
- Subscription-safety: spawn the genuine `claude` CLI in a PTY only; NEVER `claude -p`, never parse/inject its stream, never touch credentials. Timeline data comes only from the journal.
- Editor UI: typed cohesive controls, never raw JSON fields. New panel UI follows existing panel patterns (zustand `useEditor`, `exec()`, `commandSeq`).
- Examples are GENERATED: edit `packages/examples/generate.mjs` only; playtest expectations are probe-derived, never hand-computed.
- Tests: root `npx vitest run` AND `npm run typecheck` must both pass at every commit. TS ESM: relative imports need `.js`.
- Version bumps to 0.8.0 happen only in the final task (mirror the 0.7.0 commit 0bc5d2d pattern: 9 package.json + 3 constants).
- Node >= 20; esbuild bundles target node20. `@lydell/node-pty` stays `external` in every esbuild bundle and is required lazily server-side only.
- No AI attribution in commits. Plain human-voice commit messages.
- File-overlap sequencing: Tasks 1→2→3→4→5→6→7 share session/projectServer/store files — execute in order. Tasks 8→9→10→11 share runtime files — in order. Tasks 12→13→14→15 share program.ts/tools.ts/editor files — in order. Task 2 and Task 12/14 all touch program.ts+tools.ts: 2 before 12 before 14.

---

### Task 1: Command journal in core (`.hearth/log/commands.jsonl` + `listJournal`)

**Files:**
- Create: `packages/core/src/project/journal.ts`
- Create: `packages/core/src/commands/journalCommands.ts`
- Modify: `packages/core/src/schema/project.ts` (add `LOG_DIR`, `JOURNAL_FILE` consts next to `HISTORY_DIR` at ~:288-294)
- Modify: `packages/core/src/session.ts` (append hook in `execute()`, `SessionOptions.source`)
- Modify: `packages/core/src/commands/registry.ts` (register `listJournal`)
- Modify: `packages/core/src/project/create.ts:157` (gitignore: `.hearth/log/` stays ignored — verify the existing `.hearth` ignore already covers it; only touch if it doesn't)
- Test: `packages/core/tests/journal.test.ts`

**Interfaces:**
- Consumes: `HearthSession.execute` choke point, `summarizeCommand(name, params)` (session.ts:20-25), `HISTORY_EXEMPT` pattern, `FileSystem` abstraction used by `HistoryStore` (packages/core/src/project/history.ts).
- Produces (later tasks rely on these exactly):
  ```ts
  // packages/core/src/project/journal.ts
  export interface JournalEntry {
    seq: number; ts: string; // ISO
    source: string;          // 'editor' | 'cli' | 'mcp' | 'unknown'
    command: string; summary: string; ok: boolean;
    error?: string;                       // error code when ok=false
    detail?: Record<string, unknown>;     // small facts only
  }
  export const JOURNAL_ROTATE_MAX = 4000;
  export const JOURNAL_ROTATE_KEEP = 2000;
  export class JournalStore {
    constructor(fs: FileSystem, root: string);
    async append(entry: Omit<JournalEntry, 'seq'>): Promise<JournalEntry>; // assigns seq = maxSeq+1
    async read(opts?: { since?: number; limit?: number }): Promise<JournalEntry[]>; // ascending seq; since = strictly greater
    async lastSeq(): Promise<number>; // 0 when empty/missing
  }
  export const JOURNAL_ALLOWLIST = new Set(['runPlaytest', 'validateProject']);
  export function shouldJournal(name: string, mutates: boolean): boolean; // mutates || allowlisted
  ```
  - `listJournal` core command: read-only, permission `read-only`, params `{ since?: number, limit?: number }` (limit default 50, max 500), returns `{ entries: JournalEntry[], lastSeq: number }`.
  - `SessionOptions.source?: string` (default `'unknown'`).
  - `detail` for `runPlaytest`: `{ passed: boolean, assertions: number, failures: number }`; for `validateProject`: `{ errors: number, warnings: number }` — extracted defensively from the command result (missing fields → omit detail).
  - Journal file: `.hearth/log/commands.jsonl`, one JSON object per line, append-only via the FileSystem's append primitive (add `appendFile(path, text)` to the FileSystem interface if absent — implement for node fs with `{ flag: 'a' }`).

**Steps:**
- [ ] **Step 1: Failing tests** in `packages/core/tests/journal.test.ts` (follow the memfs/real-tmp pattern used by `packages/core/tests/history.test.ts`): (a) executing a mutating command (`createScene`) appends an entry with seq 1, source from SessionOptions, correct summary, ok=true; (b) `inspectProject` appends nothing; (c) `runPlaytest` and `validateProject` append with detail counts; (d) a failing command (createScene with a duplicate name) appends ok=false with the error code; (e) rotation: seed 4001 entries → file rewritten to newest 2000, seqs continuous; (f) `listJournal` via `session.execute` returns entries, respects since/limit, and lastSeq; (g) cross-session: a SECOND `HearthSession.open` on the same root appends seq continuing from disk (fresh-load shape per Wave D lesson); (h) journal write failure (inject an fs whose appendFile throws) → command still succeeds and result carries a warning containing `JOURNAL_RECORD_FAILED`.
- [ ] **Step 2:** `npx vitest run packages/core/tests/journal.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `journal.ts`, `journalCommands.ts`, session hook. In `session.ts`, append AFTER the history record block, inside its own try/catch mirroring the HISTORY_RECORD_FAILED pattern; journal the command only when `shouldJournal(name, def.mutates)` and never journal `listJournal` itself. Register in `registry.ts`.
- [ ] **Step 4:** Run the test file → PASS. Then `npx vitest run` (full) + `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: add command journal and listJournal command`.

### Task 2: Journal + asset-delete CLI/MCP parity, session sources

**Files:**
- Modify: `packages/cli/src/program.ts` (new `log` verb; new `delete asset` verb; pass `source: 'cli'` where the session is opened)
- Modify: `packages/mcp-server/src/tools.ts` (ToolSpec `list_journal`; pass `source: 'mcp'` at session open in `packages/mcp-server/src/server.ts` or wherever `HearthSession.open` is called)
- Modify: `apps/editor/server/projectServer.ts` (session open gains `source: 'editor'`)
- Test: `packages/cli/tests/` (extend the existing CLI test file that snapshots verb output), `packages/mcp-server/tests/` (existing tools test)

**Interfaces:**
- Consumes: `listJournal` command and `JournalEntry` from Task 1; `removeAsset` core command (existing: params `{ asset: string, deleteFile?: boolean }` — verify exact shape in `packages/core/src/commands/assetCommands.ts` before wiring).
- Produces: CLI `hearth log [--since <seq>] [--limit <n>] [--json]` printing `#seq [source] summary (ok|error-code)` lines oldest-first; CLI `hearth delete asset <asset> [--keep-file]` mapping to `removeAsset { asset, deleteFile: !keepFile }`; MCP tool `list_journal` with inputShape `{ since: z.number().int().optional(), limit: z.number().int().optional() }`.

**Steps:**
- [ ] **Step 1: Failing tests**: CLI test asserting `hearth log --json` envelope contains entries after a mutation and the human format line renders summary WITHOUT duplicating the command name (Wave D T3 lesson — summary already leads with the command); CLI test for `delete asset` + `--keep-file`; MCP test asserting `list_journal` is registered and its inputShape keys mirror the command params.
- [ ] **Step 2:** Run those test files → FAIL.
- [ ] **Step 3:** Implement verbs + ToolSpec + the three `source` labels.
- [ ] **Step 4:** Full `npx vitest run` + `npm run typecheck` → PASS.
- [ ] **Step 5:** Commit `feat: surface journal over CLI and MCP, add delete asset verb`.

### Task 3: WebSocket endpoint + external-change awareness

**Files:**
- Create: `apps/editor/server/ws.ts`
- Create: `apps/editor/server/journalWatcher.ts`
- Modify: `apps/editor/server/projectServer.ts` (export `attachWebSocket`, invalidate/reload cached session on external change; vite plugin `configureServer` hooks `server.httpServer.on('upgrade', ...)`)
- Modify: `apps/editor/electron/main.ts` (attach the same upgrade handler to the loopback server)
- Modify: `apps/editor/src/store.ts` (WS client: connect, on `journal` frames from source !== 'editor' bump `commandSeq` + `refresh()`; expose `journalFeed: JournalEntry[]` capped 200 and `wsStatus`)
- Modify: `apps/editor/package.json` (+ `ws`, `@types/ws`)
- Test: `apps/editor/server/__tests__/ws.test.ts` (or the editor's existing server test location — match it)

**Interfaces:**
- Consumes: `JournalStore.read/lastSeq` (Task 1), `createProjectServerContext` ctx and its session cache Map (projectServer.ts:173, 213-235).
- Produces (Tasks 4–6 rely on these):
  ```ts
  // apps/editor/server/ws.ts
  export type WsFrame =
    | { type: 'journal'; entries: JournalEntry[] }
    | { type: 'pty-data'; data: string }
    | { type: 'pty-exit'; code: number }
    | { type: 'pty-input'; data: string }        // client → server
    | { type: 'pty-resize'; cols: number; rows: number }
    | { type: 'pty-start'; command: 'claude' | 'codex' | 'shell'; mode?: string }
    | { type: 'pty-error'; message: string };
  export function attachWebSocket(httpServer: import('node:http').Server, ctx: ProjectServerContext): void; // path '/api/ws'
  ```
  - `journalWatcher.ts`: `startJournalWatcher(root, fs, onEntries: (entries: JournalEntry[]) => void): () => void` — fs.watch on `.hearth/log/` plus a 2000 ms poll fallback, debounced 150 ms, delivers only entries with seq > last delivered.
  - Server behavior: on external entries (any `entry.source !== 'editor'`), delete the cached session for that root BEFORE broadcasting, so the next `/api/command` re-opens from disk. Broadcast `journal` frames to all sockets for that project.
  - Store: `commandSeq` bump + `refresh()` on external journal frames; own-source frames only feed `journalFeed`.

**Steps:**
- [ ] **Step 1: Failing tests**: (a) unit-test `journalWatcher` with a temp dir — append lines via a second `JournalStore`, assert batched delivery and no duplicates; (b) integration: start a bare `node:http` server + `attachWebSocket`, connect a `ws` client, run a mutation through a SECOND HearthSession (source 'cli') on the same project root, assert a `journal` frame arrives AND a subsequent `/api/command` inspectProject from the FIRST context reflects the external change (session reloaded).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement ws.ts, journalWatcher.ts, projectServer + electron main wiring, store client (store connects lazily on project open; reconnect with backoff; browser `WebSocket` against `location.host`).
- [ ] **Step 4:** Full suite + typecheck → PASS. Manual check: `npm run dev`, open example, run `hearth create entity ...` from a terminal, watch Hierarchy refresh without reload.
- [ ] **Step 5:** Commit `feat: websocket channel with journal push and external-change session reload`.

### Task 4: PTY manager + agent detect/prepare endpoints

**Files:**
- Create: `apps/editor/server/ptyManager.ts`
- Create: `apps/editor/server/agentSetup.ts`
- Modify: `apps/editor/server/ws.ts` (route pty-* frames to the manager)
- Modify: `apps/editor/server/projectServer.ts` (routes `GET /api/agent/detect`, `POST /api/agent/prepare`)
- Modify: `apps/editor/package.json` (+ `@lydell/node-pty`)
- Test: `apps/editor/server/__tests__/ptyManager.test.ts`, `__tests__/agentSetup.test.ts`

**Interfaces:**
- Consumes: `WsFrame` pty types (Task 3), `ctx.meta()` toolPaths resolution (projectServer.ts:515-547).
- Produces:
  ```ts
  // ptyManager.ts — node-pty injected for testability
  export interface PtyBackend { spawn(file: string, args: string[], opts: {cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv}): PtyHandle }
  export interface PtyHandle { onData(cb: (d: string) => void): void; onExit(cb: (e: {exitCode: number}) => void): void; write(d: string): void; resize(c: number, r: number): void; kill(): void }
  export class PtyManager {
    constructor(backend?: PtyBackend);              // default: lazy import('@lydell/node-pty')
    start(root: string, command: 'claude' | 'codex' | 'shell', opts: {cols: number; rows: number}): PtyHandle; // kills any existing pty for root first
    write(root: string, data: string): void;
    resize(root: string, cols: number, rows: number): void;
    kill(root: string): void;
  }
  // agentSetup.ts
  export function detectAgents(): Promise<{ claude: {found: boolean; version?: string}; codex: {found: boolean; version?: string} }>; // `which` + `--version`, 3s timeout each
  export function prepareMcpConfig(root: string, mcpPath: string, mode: 'read-only'|'safe-edit'|'full'|'all'): Promise<{ written: boolean }>; // merge-writes .mcp.json preserving other servers
  ```
  - `.mcp.json` hearth entry written exactly as the AgentPanel documents today: `{ "mcpServers": { "hearth": { "command": "node", "args": [<mcpPath>, "--project", <root>, "--mode", <mode>] } } }` — merged, never clobbering sibling servers; idempotent.
  - `shell` command = `process.env.SHELL || (win32 ? 'powershell.exe' : '/bin/bash')`, no args; `claude`/`codex` spawned bare (PATH-resolved) with cwd=root and inherited env.
  - Socket close / project switch / new `pty-start` all kill the previous PTY (no orphans).

**Steps:**
- [ ] **Step 1: Failing tests** with a fake `PtyBackend` (records spawns, replayable data/exit): start/write/resize/kill lifecycle; second start kills first; frames routed through a ws pair end-to-end (pty-start → spawn with cwd=root; pty-input → write; backend data → pty-data frame; exit → pty-exit). agentSetup: `.mcp.json` created fresh, merged into existing file with another server preserved, re-run idempotent; detect returns found=false cleanly for a missing binary (point PATH at an empty temp dir).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Real `@lydell/node-pty` is only imported inside the default backend factory via dynamic `import()`.
- [ ] **Step 4:** Full suite + typecheck → PASS. Manual: dev editor, `pty-start shell` from devtools ws, see echo.
- [ ] **Step 5:** Commit `feat: pty manager and agent detect/prepare endpoints`.

### Task 5: Agent panel — terminal + launch flow

**Files:**
- Rewrite: `apps/editor/src/components/AgentPanel.tsx` (becomes the live panel; existing copy-paste blocks move into a collapsible "Manual setup" section at the bottom, content preserved)
- Create: `apps/editor/src/components/agent/Terminal.tsx` (xterm wrapper)
- Create: `apps/editor/src/components/agent/useAgentSocket.ts` (pty frames over the store's WS)
- Modify: `apps/editor/src/store.ts` (agent state: `agentStatus: 'idle'|'running'|'exited'`, `agentMode`, detect results)
- Modify: `apps/editor/package.json` (+ `@xterm/xterm`, `@xterm/addon-fit`)
- Test: component smoke tests per the editor's existing test setup if present; otherwise server-independent unit tests for the socket hook reducer logic. (Check `apps/editor` for existing component test infra FIRST; do not invent a new test framework — if none exists, logic-only tests.)

**Interfaces:**
- Consumes: WsFrame pty types, `/api/agent/detect`, `/api/agent/prepare`, `meta.toolPaths`, PERMISSION_MODES list already in AgentPanel.tsx:62-77.
- Produces: Panel UX for Task 6 to extend — header row: permission-mode `<select>` (default `safe-edit`), primary button [Start Claude Code] (detect-gated: if missing, shows [Install Claude Code] which runs `npm install -g @anthropic-ai/claude-code` VISIBLY in the terminal then re-detects), secondary [Open Terminal] (plain shell), [Stop]. Start flow = `POST /api/agent/prepare` (mode) → `pty-start {command:'claude', mode}`. xterm fits the panel, dark theme consistent with editor palette, disposes on unmount; PTY survives panel hide (dockview visibility) but dies on project switch.

**Steps:**
- [ ] **Step 1:** Failing logic tests for the hook/reducer (frame → terminal write queue, status transitions on pty-exit, restart clears state).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement Terminal.tsx + panel + store fields. Keep `PanelId 'agent'` (no layout.ts changes needed).
- [ ] **Step 4:** Full suite + typecheck → PASS. Manual: dev editor → Agent panel → Open Terminal → run `ls`; if `claude` installed, Start Claude Code and confirm `.mcp.json` written and the CLI boots with the hearth server listed.
- [ ] **Step 5:** Commit `feat: embedded agent terminal panel with claude launch flow`.

### Task 6: Agent panel — trust timeline + session controls

**Files:**
- Create: `apps/editor/src/components/agent/Timeline.tsx`
- Modify: `apps/editor/src/components/AgentPanel.tsx` (layout: terminal left ~65%, timeline right ~35%, header actions)
- Modify: `apps/editor/src/store.ts` (journalFeed already exists from Task 3; add `snapshotTaken` flag)
- Test: Timeline row-rendering logic tests (pure function mapping JournalEntry → row model)

**Interfaces:**
- Consumes: `journalFeed: JournalEntry[]` (Task 3), `exec('snapshotProject'|'revertProject')` and `refreshDiff()` (store), dockview `showPanel('diff')` pattern (Workspace.tsx:239-283).
- Produces: `entryToRow(entry: JournalEntry): { icon: string; label: string; status: 'ok'|'error'; meta?: string; time: string }` — playtest rows meta `"3/3 assertions"` or `"2 failed"`; validate rows meta `"0 errors, 1 warning"`; error rows show the error code. Header: [Snapshot] (exec snapshotProject; shows check when taken this session), [Review changes] (focus Diff panel + refreshDiff), [Revert session] (confirm dialog → exec revertProject). Timeline newest-first, auto-scroll pinned to top unless user scrolled, capped at the store's 200.

**Steps:**
- [ ] **Step 1:** Failing tests for `entryToRow` covering the detail variants + error case.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement Timeline + header actions + layout.
- [ ] **Step 4:** Full suite + typecheck → PASS. Manual: with the panel open run `hearth create entity` externally → row appears AND Hierarchy refreshes; Review focuses Diff.
- [ ] **Step 5:** Commit `feat: agent activity timeline and session controls`.

### Task 7: Electron packaging for node-pty + smoke

**Files:**
- Modify: `apps/editor/scripts/assemble-app.mjs` (release-app package.json gains `dependencies: { "@lydell/node-pty": "<pinned exact version>" }`; run `npm install --omit=dev` in release-app during assembly, cache-safe)
- Modify: `apps/editor/package.json` build config (`asarUnpack` += `"node_modules/@lydell/node-pty/**"`; verify `npmRebuild` default doesn't try to gyp-rebuild prebuilds — set `"npmRebuild": false` if needed since @lydell ships prebuilt binaries only)
- Modify: `apps/editor/scripts/build-electron.mjs` (`external` += `@lydell/node-pty`)
- Modify: the `HEARTH_SMOKE=1` self-test path in `apps/editor/electron/main.ts` (assert `require('@lydell/node-pty')` resolves and `spawn` of the platform shell echoes — kill within 3 s)
- Test: smoke assertion itself + `npm run app:dist` locally

**Interfaces:**
- Consumes: PtyManager default backend (Task 4) — its dynamic import must resolve inside the packaged app (asar.unpacked path).
- Produces: packaged apps on all 3 OSes with a working PTY; Release workflow unchanged otherwise (check `.github/workflows/release.yml` — if it prunes or restructures apps/editor before `app:dist`, accommodate the new install step).

**Steps:**
- [ ] **Step 1:** Extend smoke to fail first (assert pty module loads — run `HEARTH_SMOKE=1 npm run app` before packaging changes if quick, else rely on app:dist).
- [ ] **Step 2:** Implement assemble/asarUnpack/external changes.
- [ ] **Step 3:** `npm run app:dist` → launch the packaged .app → `HEARTH_SMOKE=1` passes; open Agent panel → Open Terminal works in the packaged app.
- [ ] **Step 4:** Full suite + typecheck still PASS.
- [ ] **Step 5:** Commit `build: package node-pty prebuilds in the desktop app`.

### Task 8: Benchmark harness + baseline performance.md

**Files:**
- Create: `packages/runtime/bench/bench.mjs` (runner), `packages/runtime/bench/scenarios.mjs` (project builders)
- Create: `docs/performance.md`
- Modify: root `package.json` (`"bench": "node packages/runtime/bench/bench.mjs"`), CI workflow (`ci.yml`: add a smoke-mode step `node packages/runtime/bench/bench.mjs --smoke`)
- Test: `packages/runtime/tests/bench.test.ts` (smoke: each scenario builds a valid project and runs 10 frames)

**Interfaces:**
- Consumes: `GameSession` + `SceneRuntime.run(frames)` headless stepping (wall-clock-free), `@hearth/core` schemas to build in-memory projects.
- Produces:
  ```
  // scenarios.mjs
  export const SCENARIOS = [
    { name: 'colliders-100',  build: () => Project }, // 100 moving box/circle colliders bouncing in a walled arena
    { name: 'colliders-500',  build }, // 500
    { name: 'colliders-1500', build }, // 1500
    { name: 'tilemap-arena',  build }, // 200 movers + 100×60 solid tilemap
    { name: 'particles',      build }, // 50 emitters at maxParticles
    { name: 'mixed-horde',    build }, // 800 movers, 3 collision layers, contact events firing
  ];
  // bench.mjs: per scenario — 120 warmup frames, then 1000 timed frames (--smoke: 10/10);
  // report mean / p95 / max ms-per-frame + steady entity count as an aligned table AND --json.
  ```
  Scenario projects are built with seeded determinism (fixed seed per scenario) so before/after comparisons are stable.
- `docs/performance.md`: table of BASELINE numbers (label the machine: Apple Silicon dev machine, node version), an interpretation paragraph per scenario (what it means in game terms at 60 Hz = 16.6 ms budget), how to run (`npm run bench`), and a "current bottlenecks" section naming O(n²) pairs / per-frame tilemap boxes / getEntities allocation (to be updated by Task 11).

**Steps:**
- [ ] **Step 1:** Failing smoke test (scenarios module missing).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement scenarios + runner; run `npm run bench` and paste real baseline numbers into docs/performance.md.
- [ ] **Step 4:** Full suite + typecheck + CI-smoke step locally → PASS.
- [ ] **Step 5:** Commit `feat: headless benchmark harness with baseline numbers`.

### Task 9: Frame-scoped entity cache + tilemap collider cache + golden test infra

**Files:**
- Modify: `packages/runtime/src/runtime.ts` (`getEntities()` cache; tilemap box cache; invalidation on spawn/destroy/setEnabled/flushDestroyed and on Tilemap/Transform mutation paths)
- Create: `packages/runtime/tests/determinism.ts` (shared helper: `stateHash(session): string` — stable JSON of every entity's id/position/velocity/enabled + frame + RNG-visible outputs like particle counts; `runHash(project, scene, frames, seed)`)
- Test: `packages/runtime/tests/perfCache.test.ts`
- Golden: `packages/runtime/tests/goldenDeterminism.test.ts` (started here, extended in Task 10)

**Interfaces:**
- Consumes: `entities` array + `destroyedIds` (runtime.ts:237-238, 319-320), `tilemapBoxes` (physics.ts:114-132), collection at runtime.ts:1671.
- Produces: internal only — `getEntities()` keeps its exact signature and RETURN ORDER; returned array is the cache (callers must not mutate — audit all ~40 call sites for mutation before landing, fix any by copying at that call site). Tilemap cache: `Map<entityId, { key: string; boxes: Box[] }>` where key = `grid.join('\n')|tileSize|solid|wx|wy`; recomputed only on key change. Golden helper is the contract Task 10's broadphase tests build on.

**Steps:**
- [ ] **Step 1:** Failing tests: entity-cache invalidation (spawn mid-frame visible same frame per current semantics — probe CURRENT behavior first and pin it, do not invent semantics); tilemap cache invalidation on `setComponentProperty Tilemap.grid` during play (live-patch path) and on entity move; goldenDeterminism: record `runHash` for 3 seeded scenario scenes at HEAD (compute by running the test once against unmodified code and hard-coding the hashes) — these pins must survive this task and Task 10/11 unchanged.
- [ ] **Step 2:** Run → new tests FAIL (helpers missing), goldens PASS against current code (that's the point — write goldens first, verify they pass BEFORE the perf change, then keep them green).
- [ ] **Step 3:** Implement caches.
- [ ] **Step 4:** Goldens still PASS byte-identical; full suite + typecheck PASS; `npm run bench` shows tilemap-arena improved (note numbers for Task 11's doc update).
- [ ] **Step 5:** Commit `perf: frame-scoped entity cache and tilemap collider cache`.

### Task 10: Spatial-hash broadphase (order-preserving, bit-identical)

**Files:**
- Create: `packages/runtime/src/broadphase.ts`
- Modify: `packages/runtime/src/runtime.ts:1732-1791` (stepPhysics pair loops consume broadphase candidates)
- Test: `packages/runtime/tests/broadphase.test.ts`, extend `goldenDeterminism.test.ts`

**Interfaces:**
- Consumes: `Mover`/`Obstacle` collection arrays (runtime.ts:1638-1681), shape AABBs (add `shapeAabb(shape): {minX,minY,maxX,maxY}` to broadphase.ts covering box/circle/polygon).
- Produces:
  ```ts
  // broadphase.ts
  export class SpatialHash<T> {
    constructor(cellSize: number);
    insert(index: number, aabb: Aabb): void;
    query(aabb: Aabb): number[]; // candidate indices, ASCENDING, deduped
  }
  export function chooseCellSize(aabbs: Aabb[]): number; // max extent, min 32
  ```
  **The order contract (verbatim from spec):** movers iterate in entity order exactly as today; per mover, obstacle candidates from `query()` are visited in ascending collection index; mover×mover uses `query()` results filtered to `j > i`, visited ascending. `layersInteract` and `computeShapePush` calls happen in identical sequence for all surviving pairs; pruned pairs are exactly those whose AABBs (inflated by 0 — exact AABB overlap test with the same >=/<= inclusivity as the SAT prefilter at physics.ts:176-182... use STRICT consistency: a pair pruned by broadphase must be one `computeShapePush` would return null for; when in doubt inflate AABBs by 1px to be conservative) cannot collide. Conservative pruning is safe; over-pruning is a correctness bug goldens will catch.
  Rebuild the hash each frame from the collected arrays (arrays are already per-frame); obstacles inserted once, movers re-queried after each position mutation is NOT needed because today's inner loop also uses the mover's updated shape — query with the mover's PRE-loop AABB inflated by its max possible push? NO — simpler and safe: query with the mover AABB inflated by 2× max obstacle extent margin... **Decision (implement exactly this):** query using the mover's current AABB inflated by `cellSize`; since applyPush displacements per frame are bounded well below cellSize (pushes resolve overlap only), the inflation covers mid-loop movement. Add a test with a deep-overlap stack (10 movers stacked on one point on a platform) asserting identical hashes vs naive.
- Naive reference: `naivePairs(movers, obstacles)` kept in the TEST file only, mirroring today's loops, used property-style: 200 random seeded scenes × both paths → identical `stateHash`.

**Steps:**
- [ ] **Step 1:** Failing tests: SpatialHash unit (ascending dedup, cell boundaries, huge AABB spanning many cells); property test naive-vs-broadphase over seeded random scenes (movers+obstacles incl. circles, polygons, one-way platforms, triggers, tilemaps); goldens from Task 9 must stay green.
- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement; wire into stepPhysics.
- [ ] **Step 4:** All goldens + property tests PASS; full suite + typecheck PASS; `npm run bench` — record collider-1500 and mixed-horde improvements.
- [ ] **Step 5:** Commit `perf: spatial-hash broadphase with order-preserving pair pruning`.

### Task 11: Particle pooling + pointermove throttle + final bench numbers

**Files:**
- Modify: `packages/runtime/src/particles.ts` (free-list pool per EmitterState; `spawnOne` reuses; expiry swaps into pool instead of splice — PRESERVE array iteration order semantics: keep live particles' relative order stable, e.g. swap-remove is NOT order-stable — use pool of detached objects + splice retained if order matters to rendering... check pixi particle rendering: if it iterates `state.particles` in order, keep splice for liveness but push expired objects to a `pool: Particle[]` and reuse in spawnOne; that alone removes per-spawn allocation)
- Modify: `apps/editor` / `packages/runtime/src/pixi/index.ts` pointermove handler (coalesce to one `resolveUiPositions`-consuming dispatch per animation frame)
- Modify: `docs/performance.md` (AFTER table: same scenarios, same machine; before/after deltas; rewrite "current bottlenecks" honestly)
- Test: extend `packages/runtime/tests/particles.test.ts` (counts/behavior identical: seeded emitter runs produce identical particle position arrays pre/post pooling; maxParticles cap; assertParticleCount playtests all still green), goldens stay green
- [ ] **Step 1:** Failing/pinning tests first (seeded particle position snapshot vs current code).
- [ ] **Step 2–4:** Implement, run `npm run bench`, update performance.md with real after-numbers, full suite + typecheck PASS.
- [ ] **Step 5:** Commit `perf: particle pooling, pointer reflow throttle, published before/after numbers`.

### Task 12: Scene/entity duplication commands + rename fix (core + CLI + MCP)

**Files:**
- Modify: `packages/core/src/commands/sceneCommands.ts` (duplicateScene `withPlaytests?: boolean`; renameScene collision rejection)
- Modify: `packages/core/src/commands/entityCommands.ts` (new `duplicateEntity`)
- Modify: `packages/core/src/commands/registry.ts`, `packages/cli/src/program.ts`, `packages/mcp-server/src/tools.ts`
- Test: `packages/core/tests/sceneDuplicate.test.ts`, extend entity command tests, CLI/MCP registration tests

**Interfaces:**
- Consumes: existing `duplicateScene` (sceneCommands.ts:78-108), id map pattern there; `generateId('ent'|'ptt')`; playtest files convention `playtests/<name>.playtest.json`; `getScene` resolution (store.ts:149-157).
- Produces:
  - `duplicateScene` params `{ scene: string, newName: string, withPlaytests?: boolean }`. With playtests: for every playtest whose `scene` resolves to the source scene, clone with fresh `ptt_` id, `scene` = new scene id, name `"<original> (<newName>)"` (suffix ` 2`, ` 3`… on collision), and every step field that equals an OLD entity id remapped via the id map (fields: any step property named `entity` plus `assertScene` scene refs; name-based refs left untouched). Return gains `playtestsCloned: number`.
  - `renameScene`: reject when `store.getScene(newName)` resolves to a DIFFERENT scene id → error code `SCENE_NAME_TAKEN` with suggestion.
  - `duplicateEntity` `{ scene: string, entity: string, newName?: string, offset?: {x: number, y: number} }`, permission `safe-edit`, mutates. Deep: BFS over flat entity list collecting the target + all descendants via parentId; fresh `ent_` ids; parentId remapped inside the subtree; the ROOT copy's parentId = original's parentId; root name = newName ?? `"<name> copy"` ; offset (default `{x:16,y:16}`) applied to the ROOT's Transform.position only (children are relative via world-position parenting? VERIFY: children store absolute or parent-relative Transforms — read getWorldPosition (runtime.ts:370-384) and mirror reality; if positions are parent-relative, offset root only is correct). Returns `{ entityId, name, copiedCount }`.
  - CLI: `hearth duplicate scene <scene> <newName> [--with-playtests]`, `hearth duplicate entity <scene> <entity> [--name <n>] [--offset x,y]`. MCP: `duplicate_scene`, `duplicate_entity` ToolSpecs with mirrored shapes.
- [ ] **Steps 1–5:** TDD as usual — failing tests for: deep tree duplicate (3-level parent chain + sibling, ids fresh, parentId remap, offset applied to root only), playtest cloning (entity-id steps remapped, name-based steps untouched, collision suffix), rename collision (and case-insensitive collision), CLI/MCP registration parity. Full suite + typecheck. Commit `feat: entity duplication, playtest-aware scene duplication, rename collision guard`.

### Task 13: Editor scene manager menu + deep Hierarchy duplicate

**Files:**
- Modify: `apps/editor/src/components/Toolbar.tsx` (scene ⋯ menu: Duplicate… / Rename… / Set as initial / Delete… with confirm; modals follow the existing new-scene modal pattern at Toolbar.tsx:26-33)
- Modify: `apps/editor/src/components/Hierarchy.tsx:47-57` (Duplicate action → `exec('duplicateEntity', ...)`, delete the client-side shallow copy)
- Test: any existing editor logic-test seams; otherwise behavior verified via the commands' own tests + manual checklist in the report

**Interfaces:** Consumes `duplicateScene/renameScene/setInitialScene/deleteScene/duplicateEntity` via `exec()`; `selectScene` store action. Delete of the ACTIVE scene selects the initial scene after; deleting the last scene is blocked by core (verify — if not, disable the menu item when `scenes.length === 1`).
- [ ] **Steps:** implement, manual-verify all five actions in dev editor, full suite + typecheck, commit `feat: scene management menu and deep entity duplicate in editor`.

### Task 14: Tilemap commands (core + CLI + MCP)

**Files:**
- Create: `packages/core/src/commands/tilemapCommands.ts`
- Modify: `registry.ts`, `program.ts`, `tools.ts`
- Test: `packages/core/tests/tilemap.test.ts`

**Interfaces:**
- Produces (all permission `safe-edit`, mutates, target must have a Tilemap component else `NO_TILEMAP` error):
  - `paintTiles { scene, entity, cells: Array<{x: number, y: number, char: string}> }` — x = column, y = row (0-based, row 0 = grid[0] = top). Every char must be a single character that is `.`/space or a key of `tileAssets` (`INVALID_TILE_CHAR`); every cell in bounds (`TILE_OUT_OF_BOUNDS`, suggestion: resizeTilemap). Batched: one command = one history entry. Returns `{ painted: number }`.
  - `fillTilemapRect { scene, entity, x, y, width, height, char }` — same validation; returns `{ painted }`.
  - `resizeTilemap { scene, entity, width, height, anchor?: 'top-left' }` — grow pads with `.`, shrink crops from the far edges; width/height >= 1, <= 1024. Returns `{ width, height }`.
  - CLI: `hearth paint tiles <scene> <entity> --cells "x,y,c;x,y,c"` , `hearth fill tiles <scene> <entity> --rect x,y,w,h --char <c>`, `hearth resize tilemap <scene> <entity> --size w,h`. MCP: `paint_tiles`, `fill_tilemap_rect`, `resize_tilemap`.
  - Implementation note: strings are immutable — rebuild affected row strings once per command from a char-array working copy; re-validate the component via the existing setComponentProperty validation path or schema parse.
- [ ] **Steps 1–5:** TDD (bounds, char validation incl. multi-char rejection, undo round-trip through history, row-string integrity for non-square grids), full suite + typecheck, commit `feat: tilemap paint, fill, and resize commands with CLI and MCP parity`.

### Task 15: Tilemap paint tool + typed tileAssets control (editor)

**Files:**
- Create: `apps/editor/src/components/TilemapPainter.tsx` (palette overlay + SceneView interaction layer)
- Modify: `apps/editor/src/components/SceneView.tsx` (paint mode when selected entity has Tilemap: pointer → cell coords via tileSize + entity world position; drag accumulates cells, pointerup dispatches ONE `paintTiles`; shift-drag preview rect → ONE `fillTilemapRect`)
- Modify: `apps/editor/src/components/Inspector.tsx:679-682` (replace JsonField fallback for `Tilemap.tileAssets` with a typed `TileAssetsField`: rows of [single-char input][image-asset dropdown][remove], + add row; edits dispatch setComponentProperty on the whole map)
- Test: cell-coordinate math + stroke-batching pure functions

**Interfaces:** Consumes `paintTiles`/`fillTilemapRect` (Task 14), `exec()`, existing SceneView selection state, asset list from store for the dropdown (filter `type === 'image'` — verify the asset type field name in store/inspectAssets). Palette swatches render the mapped assets' textures (fallback: the char itself); includes an eraser (`.`). Esc or deselect exits paint mode; normal entity-drag interactions suppressed while painting.
- [ ] **Steps:** TDD the math, implement, manual-verify painting/fill/undo (one Cmd+Z per stroke) in dev editor, full suite + typecheck, commit `feat: tilemap paint tool and typed tile-asset mapping control`.

### Task 16: Gamepad axis threshold hysteresis

**Files:**
- Modify: `packages/runtime/src/input.ts` (threshold bindings latch: engage at `>= effective`, release at `< effective - 0.05` where effective = max(threshold, deadzone); track per pad+binding latch state)
- Modify: `docs/input.md` (one paragraph documenting the hysteresis)
- Test: extend `packages/runtime/tests/` gamepad tests (value sequence 0.49→0.51→0.49→0.44 with threshold 0.5: down at 0.51, STAYS down at 0.49, up at 0.44; justPressed fires once)
- [ ] **Steps:** TDD, full suite + typecheck, commit `fix: hysteresis on gamepad axis thresholds`.

### Task 17: Ember Horde example (9th)

**Files:**
- Modify: `packages/examples/generate.mjs` (new generator: ember-horde), regenerate ALL examples (AGENTS.md templates pick up nothing new this wave — regenerate anyway for consistency)
- Test: examples CI playtests run green

**Content contract:** one arena scene (solid tilemap border walls), all-Lua scripts; player with virtual-axis movement (`ctx.input.axis`) + gamepad bindings; a director script spawning enemy waves via `ctx.scene.instantiate` from a disabled template entity, enemies steering toward the player each frame (normalize player-pos − self-pos, speed constant), capped at 300 concurrent; `enemy`/`player` collision layers; on player-enemy contact: `ctx.camera.shake` + pooled hit-spark particle burst + score/HP HUD update (UIText + UILayout HUD, pause menu with UIToggle for shake, reusing Wave D widgets); survivors-style timer. Playtests (probe-derived, NEVER hand-computed): smoke boot; sustained-horde frame N with `assertEntityCount`-style check at scale (use the actual step/assert types that exist — check schema/project.ts playtest steps before writing); event/collision assertion; pause-menu focus assertion. Bench doc cross-links the example as the playable companion.
- [ ] **Steps:** probe first (run the scene headless, derive expectations), generate, run example playtests + full suite + typecheck, commit `feat: ember horde example proving horde-scale gameplay`.

### Task 18: Docs, counts, version 0.8.0

**Files:**
- Create: `docs/agent-panel.md` (what it is, subscription-safety/legal position from the spec, permission modes, manual setup, external-change model/conflict note, troubleshooting incl. install/login)
- Modify: `docs/cli.md` (log, delete asset, duplicate scene/entity, paint/fill/resize verbs + envelope examples), `docs/mcp.md` (new tools + counts), `docs/project-format.md` (`.hearth/log/commands.jsonl` + journal entry shape), `docs/roadmap.md` (mark §9 v1/§14 shipped; remaining: chat UI/API-key adapter, codex auto-wiring, shaders tier 2, prefabs, notarization), `README.md` (What's in the engine + Status + command/tool counts + docs table row for agent-panel + performance), `packages/mcp-server/README.md`, `docs/input.md` already updated in Task 16
- Modify: version 0.8.0 in all 9 package.json + 3 constants files (find them: `grep -rn "0\.7\.0" --include=package.json` + the three VERSION constants mirroring commit 0bc5d2d)
- Test: any doc-drift tests (counts tests exist for commands/tools — update expected numbers: commands 51 → 57 (`listJournal, duplicateEntity, paintTiles, fillTilemapRect, resizeTilemap` +5... VERIFY: duplicateScene already counted; recount from registry at implementation time and use the real number), MCP tools 48 → 54 (`list_journal, duplicate_scene, duplicate_entity, paint_tiles, fill_tilemap_rect, resize_tilemap`); examples 8 → 9)
- [ ] **Steps:** write docs, bump versions, full suite + typecheck, commit `docs: wave E documentation and v0.8.0 version bump`.

---

## Self-review notes (resolved inline)

- Spec coverage: A→T1/T2, B→T3, C→T4/T5/T7, D→T4/T5, E→T6, F→T8, G→T9/T10/T11, H→T12/T13, I→T14/T15, J→T17, K→T2 (delete asset) / T11 (throttle) / T16 (hysteresis), release→T18. Covered.
- Type consistency: `JournalEntry`, `WsFrame`, `PtyManager`, command param shapes are quoted identically where consumed (T3/T4/T5/T6 vs T1; T13/T15 vs T12/T14).
- Deliberate openness: exact command/tool counts recounted at T18 from the registry (source of truth) rather than trusted from this plan.
