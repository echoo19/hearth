# Agent Panel UX (right dock + zero-friction launch) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Agent panel from the bottom dock to its own full-height right dock and replace its config-screen first-run with a one-click "Launch your agent" tile flow.

**Architecture:** The dockview layout gains a fourth column (agent, right of inspector) with a version-2 persisted-layout envelope that migrates v1 saves by relocating just the agent panel. `AgentPanel.tsx` becomes a three-state machine (launcher | running | exited) delegating to a new presentational `agent/Launcher.tsx`; the terminal stacks over a collapsible Activity (Timeline) section. Zero server/CLI/MCP surface changes — detect/prepare/PTY plumbing is reused untouched.

**Tech Stack:** React 18, dockview-react, zustand store, xterm (lazy), vitest (node + jsdom w/ dockview-core for dock tests).

**Spec:** `docs/superpowers/specs/2026-07-15-agent-panel-ux-design.md` (decisions locked there).

## Global Constraints

- Branch: `v1.1.1-editor-fixes`. NO AI attribution in commits (no Co-Authored-By, no "Generated with").
- Subscription safety: never touch agent CLI flags/stream/credentials beyond `cwd` + standard MCP config. `ptyManager.resolveCommand` stays bare/interactive.
- House UI rules: shared `Button`/`Tooltip`/`MenuButton` primitives, `--text-*` tokens, single-theme dark, no raw-JSON surfaces, keyboard a11y (real `<button>`s, visible focus).
- Anti-bloat: identical capability set, no new commands/panels/server routes.
- `npx vitest run` does NOT typecheck — run `npm run typecheck` too before every commit claim.
- The copy sweep (`apps/editor/tests/copySweep.test.ts`) and style gates (`apps/editor/tests/styleGates.test.ts`) must stay green — new copy is plain language, new CSS uses tokens.
- TS ESM NodeNext: relative imports need `.js`? — NO for the editor app (vite/bundler resolution, look at neighboring imports and match them exactly).
- Do not edit `hearth-website` or any generated content in this wave.

---

### Task 1: Layout envelope v2 (accept + flag v1 saves)

**Files:**
- Modify: `apps/editor/src/workspace/layout.ts`
- Modify: `apps/editor/src/workspace/Workspace.tsx` (call-site only: `initLayout` reads `stored.layout`)
- Test: `apps/editor/tests/workspaceLayout.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `LAYOUT_VERSION = 2`; `interface RestoredLayout { layout: unknown; migrateAgentDock: boolean }`; `restoreLayout(raw: string | null | undefined): RestoredLayout | null` (v1 envelopes are accepted with `migrateAgentDock: true`, v2 with `false`, everything else `null`). Task 2 consumes `migrateAgentDock`.

- [ ] **Step 1: Write the failing tests** — in `workspaceLayout.test.ts`, replace the two version-related tests and the round-trip assertion:

```ts
it('round-trips a layout through serialize/restore', () => {
  const layout = sampleLayout();
  const restored = restoreLayout(serializeLayout(layout));
  expect(restored).toEqual({ layout, migrateAgentDock: false });
});

it('stamps the current layout version', () => {
  const stored = JSON.parse(serializeLayout(sampleLayout())) as { version: number };
  expect(stored.version).toBe(2);
});

it('accepts a version-1 envelope and flags it for the agent-dock migration', () => {
  const v1 = JSON.stringify({ version: 1, layout: sampleLayout(['scene', 'agent']) });
  const restored = restoreLayout(v1);
  expect(restored).not.toBeNull();
  expect(restored!.migrateAgentDock).toBe(true);
  expect(restored!.layout).toEqual(sampleLayout(['scene', 'agent']));
});

it('rejects a version-stamped envelope from an unknown layout version', () => {
  const stale = JSON.stringify({ version: LAYOUT_VERSION + 1, layout: sampleLayout() });
  expect(restoreLayout(stale)).toBeNull();
  expect(restoreLayout(JSON.stringify({ version: 0, layout: sampleLayout() }))).toBeNull();
});
```

- [ ] **Step 2: Run tests, verify they fail** — `npx vitest run apps/editor/tests/workspaceLayout.test.ts`. Expected: failures on the new/changed assertions (restoreLayout currently returns the bare layout and rejects v1... wait, it currently ACCEPTS v1 as current — the round-trip and v1 tests fail on shape).

- [ ] **Step 3: Implement** — in `layout.ts`:

```ts
export const LAYOUT_VERSION = 2;

export interface RestoredLayout {
  layout: unknown;
  /**
   * True when the envelope predates v2 — the Agent panel's move from the
   * bottom dock to its own right-hand dock. After `fromJSON` the caller must
   * relocate the agent panel (Workspace's `relocateAgentPanel`) so a v1 save
   * keeps the user's layout but the agent lands in the new dock.
   */
  migrateAgentDock: boolean;
}

export function restoreLayout(raw: string | null | undefined): RestoredLayout | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const stored = parsed as Partial<StoredLayout>;
  if (stored.version !== 1 && stored.version !== LAYOUT_VERSION) return null;
  if (!isValidDockviewLayout(stored.layout)) return null;
  return { layout: stored.layout, migrateAgentDock: stored.version === 1 };
}
```

Update the file-header docblock: stale saves from unknown versions fall back to default; v1 is migrated, not discarded. Then fix the one call site so the repo typechecks — in `Workspace.tsx`'s `initLayout`, change `api.fromJSON(stored as SerializedDockview)` to `api.fromJSON(stored.layout as SerializedDockview)` (migration wiring itself is Task 2).

- [ ] **Step 4: Run tests + typecheck** — `npx vitest run apps/editor/tests/workspaceLayout.test.ts apps/editor/tests/workspaceDock.test.ts && npm run typecheck -w @hearth/editor`. Expected: PASS (workspaceDock may reference restoreLayout — fix its call sites the same way if so).

- [ ] **Step 5: Commit** — `git add -A apps/editor && git commit -m "Accept v1 layout saves and flag them for the agent-dock migration"`

---

### Task 2: Right-dock default layout, showPanel, and v1 migration

**Files:**
- Modify: `apps/editor/src/workspace/Workspace.tsx`
- Test: `apps/editor/tests/workspaceDock.test.ts`

**Interfaces:**
- Consumes: `RestoredLayout.migrateAgentDock` from Task 1.
- Produces: `export const AGENT_WIDTH = 380` (module const, export not required unless tests want it — export it for tests), `export function relocateAgentPanel(api: DockviewApi): void`. Default layout: agent in its own group right of inspector. `showPanel(api, 'agent')` re-opens at the right edge, never the bottom group.

- [ ] **Step 1: Write the failing tests** — append to `workspaceDock.test.ts` (reuse its `makeDock` helper; note `buildDefaultLayout` needs the panel registry only via `createComponent` stub, which already exists):

```ts
describe('agent right dock (v1.2 layout)', () => {
  it('default layout puts agent in its own group beside the inspector, not the bottom group', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    const agent = api.getPanel('agent')!;
    const assets = api.getPanel('assets')!;
    expect(agent.group.panels.map((p) => p.id)).toEqual(['agent']);
    expect(agent.group).not.toBe(assets.group);
  });

  it('showPanel reopens a closed agent panel into its own group, not the bottom dock', () => {
    const api = makeDock();
    buildDefaultLayout(api);
    api.removePanel(api.getPanel('agent')!);
    showPanel(api, 'agent');
    const agent = api.getPanel('agent')!;
    expect(agent.group.panels.map((p) => p.id)).toEqual(['agent']);
  });

  // Replicates the v1 default: agent tabbed inside the bottom (assets) group.
  function buildV1Layout(api: DockviewApi): void {
    api.clear();
    api.addPanel({ id: 'scene', component: 'scene', title: 'Scene' });
    api.addPanel({ id: 'inspector', component: 'inspector', title: 'Inspector', position: { referencePanel: 'scene', direction: 'right' }, initialWidth: 300 });
    api.addPanel({ id: 'assets', component: 'assets', title: 'Assets', position: { referencePanel: 'scene', direction: 'below' }, initialHeight: 340 });
    api.addPanel({ id: 'agent', component: 'agent', title: 'Agent', position: { referencePanel: 'assets', direction: 'within' } });
  }

  it('initLayout migrates a v1 save: agent relocates to its own right group, rest preserved, persisted as v2', () => {
    const source = makeDock();
    buildV1Layout(source);
    const key = 'hearth.layout.migrate-test';
    localStorage.setItem(key, JSON.stringify({ version: 1, layout: source.toJSON() }));

    const api = makeDock();
    initLayout(api, key);
    const agent = api.getPanel('agent')!;
    expect(agent.group.panels.map((p) => p.id)).toEqual(['agent']);
    expect(api.getPanel('assets')).toBeTruthy();
    expect(api.getPanel('inspector')).toBeTruthy();
    const persisted = JSON.parse(localStorage.getItem(key)!) as { version: number };
    expect(persisted.version).toBe(2);
  });

  it('initLayout leaves a v1 agent panel alone when the user had already given it its own group', () => {
    const source = makeDock();
    source.clear();
    source.addPanel({ id: 'scene', component: 'scene', title: 'Scene' });
    source.addPanel({ id: 'agent', component: 'agent', title: 'Agent', position: { referencePanel: 'scene', direction: 'left' } });
    const key = 'hearth.layout.solo-test';
    localStorage.setItem(key, JSON.stringify({ version: 1, layout: source.toJSON() }));

    const api = makeDock();
    initLayout(api, key);
    const agent = api.getPanel('agent')!;
    expect(agent.group.panels.map((p) => p.id)).toEqual(['agent']);
    // Still stamped v2 so the migration never re-runs.
    expect((JSON.parse(localStorage.getItem(key)!) as { version: number }).version).toBe(2);
  });

  it('initLayout of a v1 save with agent closed adds nothing but still re-stamps v2', () => {
    const source = makeDock();
    source.clear();
    source.addPanel({ id: 'scene', component: 'scene', title: 'Scene' });
    const key = 'hearth.layout.closed-test';
    localStorage.setItem(key, JSON.stringify({ version: 1, layout: source.toJSON() }));

    const api = makeDock();
    initLayout(api, key);
    expect(api.getPanel('agent')).toBeUndefined();
    expect((JSON.parse(localStorage.getItem(key)!) as { version: number }).version).toBe(2);
  });
});
```

Add `localStorage.clear()` to the file's `afterEach` if not already there.

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/editor/tests/workspaceDock.test.ts`. Expected: the new describe block fails (agent still tabs into the bottom group; initLayout doesn't migrate).

- [ ] **Step 3: Implement in `Workspace.tsx`:**

(a) Constants — replace the `BOTTOM_HEIGHT` comment/value and add `AGENT_WIDTH`:

```ts
const RIGHT_WIDTH = 300;
/** The Agent panel's own full-height dock at the right edge (v1.2): a
 * terminal wants height, and the Inspector stays visible while an agent
 * works. Wide enough for ~80 mono columns at the editor's terminal size. */
export const AGENT_WIDTH = 380;
// The bottom group is shared by every bottom-docked panel (Assets, Console,
// Diff, Input, Game Settings, Live). 260px suits log/asset surfaces; the
// Agent panel that once needed more height here lives in its own right-hand
// dock now.
const BOTTOM_HEIGHT = 260;
```

(b) `buildDefaultLayout` — after the inspector `addPanel`, insert:

```ts
api.addPanel(
  addPanelOptions('agent', {
    position: { referencePanel: 'inspector', direction: 'right' },
    initialWidth: AGENT_WIDTH,
    inactive: true,
  }),
);
```

and drop `'agent'` from the bottom-group loop: `for (const id of ['console', 'diff', 'input', 'gameSettings'] as const)`.

(c) `BOTTOM_PANELS` — remove `'agent'`:

```ts
const BOTTOM_PANELS: readonly PanelId[] = ['assets', 'console', 'diff', 'input', 'gameSettings', 'live'];
```

(d) `showPanel` — add an agent branch before the final `else`:

```ts
} else if (id === 'agent') {
  const ref = findReference(api, ['inspector']);
  extra = {
    position: ref ? { referencePanel: ref, direction: 'right' } : { direction: 'right' },
    initialWidth: AGENT_WIDTH,
  };
} else {
```

(If dockview rejects a reference-less `{ direction: 'right' }`, fall back to `findReference(api, CENTER_PANELS)` with `direction: 'right'` — the test pins the observable behavior, adapt the mechanism to what dockview-core accepts.)

(e) New exported migration helper, next to `showPanel`:

```ts
/**
 * v1→v2 layout migration: v1 saves docked the Agent panel as a tab in the
 * bottom group; v2 gives it its own full-height dock at the right edge.
 * Relocates ONLY the agent panel — the rest of the user's layout is kept.
 * A v1 agent already alone in its own group was placed there deliberately
 * by the user; respect it. A closed agent panel needs no move (showPanel
 * places it correctly when reopened).
 */
export function relocateAgentPanel(api: DockviewApi): void {
  const agent = api.getPanel('agent');
  if (!agent) return;
  if (agent.group.panels.length === 1) return;
  api.removePanel(agent);
  const ref = findReference(api, ['inspector']);
  api.addPanel(
    addPanelOptions('agent', {
      position: ref ? { referencePanel: ref, direction: 'right' } : { direction: 'right' },
      initialWidth: AGENT_WIDTH,
    }),
  );
}
```

(f) `initLayout` — wire the migration and persist immediately (one-time):

```ts
export function initLayout(api: DockviewApi, storageKey: string): void {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    /* ignore */
  }
  const stored = restoreLayout(raw);
  if (stored) {
    try {
      api.fromJSON(stored.layout as SerializedDockview);
      if (stored.migrateAgentDock) {
        relocateAgentPanel(api);
        // Persist as v2 right away so the migration runs exactly once even
        // if the user never touches the layout again this session.
        writeLayout(api, storageKey);
      }
      // Older saves persisted headless groups (`activeView: null`); heal them
      // so a restored layout doesn't come back showing the watermark.
      ensureGroupsActive(api);
      return;
    } catch {
      /* corrupt beyond what validation catches — fall through to default */
    }
  }
  buildDefaultLayout(api);
}
```

- [ ] **Step 4: Run tests + typecheck** — `npx vitest run apps/editor/tests/workspaceDock.test.ts apps/editor/tests/workspaceLayout.test.ts && npm run typecheck -w @hearth/editor`. Expected: PASS.

- [ ] **Step 5: Commit** — `git commit -am "Move the Agent panel to its own right-hand dock with v1 layout migration"`

---

### Task 3: Launcher tiles — pure model + presentational component

**Files:**
- Create: `apps/editor/src/components/agent/Launcher.tsx`
- Modify: `apps/editor/src/components/ui.tsx` (add `gear` icon glyph)
- Modify: `apps/editor/src/styles/panels/agent.css` (launcher styles; keep everything else for now)
- Modify: `apps/editor/tests/agentPanelDetect.test.ts` (import `describeLauncher` from the new module)
- Test: `apps/editor/tests/launcherTiles.test.ts`

**Interfaces:**
- Consumes: `DetectAgentsResult` (type-only, `../../server/agentSetup`), `Icon`/`Button`/`Tooltip` primitives.
- Produces (Task 4 consumes all of these):
  - `export type AgentLauncher = 'claude' | 'codex' | 'opencode' | 'hermes' | 'shell'`
  - `export type AgentToolLauncher = Exclude<AgentLauncher, 'shell'>`
  - `export const AGENT_LAUNCHER_LABELS: Record<AgentLauncher, string>` (moved verbatim from AgentPanel.tsx)
  - `export function describeLauncher(launcher: AgentLauncher, ollamaModels: string[]): string` (moved verbatim)
  - `export const INSTALL_COMMANDS: Record<AgentToolLauncher, string | null>`
  - `export type TileStatus = 'ready' | 'missing' | 'checking'`
  - `export interface LauncherTile { id: AgentToolLauncher; label: string; status: TileStatus; installCommand: string | null; hint: string }`
  - `export function launcherTiles(detect: DetectAgentsResult | null, detecting: boolean, ollamaModels: string[]): LauncherTile[]`
  - `export interface LauncherProps { tiles: LauncherTile[]; detectFailed: boolean; disabledReason: string | null; pending: AgentLauncher | null; errors: Partial<Record<AgentLauncher, string>>; modeLabel: string; gear: React.ReactNode; onLaunch(launcher: AgentLauncher): void; onInstall(tile: LauncherTile): void; onRetryDetect(): void }`
  - `export function Launcher(props: LauncherProps): JSX.Element`

- [ ] **Step 1: Verify install package names before hardcoding.** Run `npm view @openai/codex name` and `npm view opencode-ai name`. If either 404s, that launcher's `INSTALL_COMMANDS` entry becomes `null` (docs-hint path) — do NOT ship an install command that installs the wrong package. `@anthropic-ai/claude-code` is already shipped and stays.

- [ ] **Step 2: Write the failing tests** — `apps/editor/tests/launcherTiles.test.ts`:

```ts
/**
 * Pure tile-model tests for the Agent panel's "Launch your agent" first-run
 * flow. Mirrors agentPanelGuards.test.ts's style: exported pure functions,
 * no DOM.
 */
import { describe, expect, it } from 'vitest';
import { INSTALL_COMMANDS, launcherTiles } from '../src/components/agent/Launcher';
import type { DetectAgentsResult } from '../src/../server/agentSetup';

function detect(found: Partial<Record<'claude' | 'codex' | 'opencode' | 'hermes', boolean>>): DetectAgentsResult {
  const entry = (f: boolean) => ({ found: f }) as DetectAgentsResult['claude'];
  return {
    claude: entry(found.claude ?? false),
    codex: entry(found.codex ?? false),
    opencode: entry(found.opencode ?? false),
    hermes: entry(found.hermes ?? false),
    ollama: { models: [] } as DetectAgentsResult['ollama'],
  };
}

describe('launcherTiles', () => {
  it('orders installed agents first, keeping the canonical order within each half', () => {
    const tiles = launcherTiles(detect({ codex: true, hermes: true }), false, []);
    expect(tiles.map((t) => `${t.id}:${t.status}`)).toEqual([
      'codex:ready',
      'hermes:ready',
      'claude:missing',
      'opencode:missing',
    ]);
  });

  it('reports every tile as checking while detection runs or before the first result', () => {
    for (const tiles of [launcherTiles(null, true, []), launcherTiles(null, false, []), launcherTiles(detect({ claude: true }), true, [])]) {
      expect(tiles.every((t) => t.status === 'checking')).toBe(true);
    }
  });

  it('carries an install command only for launchers with a known installer', () => {
    const tiles = launcherTiles(detect({}), false, []);
    for (const tile of tiles) {
      expect(tile.installCommand).toBe(INSTALL_COMMANDS[tile.id]);
    }
    expect(INSTALL_COMMANDS.claude).toBe('npm install -g @anthropic-ai/claude-code');
  });

  it('gives each tile the launcher description as its hint', () => {
    const tiles = launcherTiles(detect({ opencode: true }), false, ['llama3']);
    const opencode = tiles.find((t) => t.id === 'opencode')!;
    expect(opencode.hint).toContain('opencode.json');
  });
});
```

(Adjust the `detect()` fixture's casts to the real `AgentDetection`/`OllamaDetection` shapes in `server/agentSetup.ts` — build honest minimal objects, not `as any`.)

- [ ] **Step 3: Run to verify failure** — `npx vitest run apps/editor/tests/launcherTiles.test.ts`. Expected: module not found.

- [ ] **Step 4: Implement `agent/Launcher.tsx`.** Move `AgentLauncher`, `AgentToolLauncher`, `AGENT_LAUNCHER_LABELS`, `AGENT_LAUNCHER_CONFIG`, and `describeLauncher` verbatim out of `AgentPanel.tsx` (leave AgentPanel importing them from here — AgentPanel is fully reworked in Task 4, but keep the repo compiling NOW by updating its imports in this task). Add:

```tsx
/**
 * First-run launch surface: "Launch your agent" + one tile per agent CLI.
 * Presentational — AgentPanel owns the store wiring, detection, prepare and
 * pty calls, and passes state down. Pure helpers exported for unit tests.
 */
export const INSTALL_COMMANDS: Record<AgentToolLauncher, string | null> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  opencode: 'npm install -g opencode-ai',
  // No single blessed installer; the tile shows "Not installed" and the
  // manual-setup disclosure / docs/connect-hermes.md cover it.
  hermes: null,
};

export type TileStatus = 'ready' | 'missing' | 'checking';

export interface LauncherTile {
  id: AgentToolLauncher;
  label: string;
  status: TileStatus;
  installCommand: string | null;
  hint: string;
}

const TILE_ORDER: readonly AgentToolLauncher[] = ['claude', 'codex', 'opencode', 'hermes'];

/**
 * Tile models for the launcher. `checking` until the FIRST detect result
 * lands (a null detect must never flash "Install" for a CLI that is in fact
 * installed — the v1.1 PATH-bug lesson); installed agents lead so the
 * common case is one click on the first tile.
 */
export function launcherTiles(
  detect: DetectAgentsResult | null,
  detecting: boolean,
  ollamaModels: string[],
): LauncherTile[] {
  const tiles = TILE_ORDER.map((id) => ({
    id,
    label: AGENT_LAUNCHER_LABELS[id],
    status: (detecting || !detect ? 'checking' : detect[id].found ? 'ready' : 'missing') as TileStatus,
    installCommand: INSTALL_COMMANDS[id],
    hint: describeLauncher(id, ollamaModels),
  }));
  return [...tiles.filter((t) => t.status === 'ready'), ...tiles.filter((t) => t.status !== 'ready')];
}
```

Component (exact markup; classNames are consumed by the CSS below):

```tsx
export interface LauncherProps {
  tiles: LauncherTile[];
  detectFailed: boolean;
  disabledReason: string | null;
  pending: AgentLauncher | null;
  errors: Partial<Record<AgentLauncher, string>>;
  modeLabel: string;
  gear: React.ReactNode;
  onLaunch(launcher: AgentLauncher): void;
  onInstall(tile: LauncherTile): void;
  onRetryDetect(): void;
}

export function Launcher({
  tiles, detectFailed, disabledReason, pending, errors, modeLabel, gear,
  onLaunch, onInstall, onRetryDetect,
}: LauncherProps) {
  const busy = pending !== null;
  return (
    <div className="agent-launcher">
      <div className="agent-launcher-hero">
        <h3>Launch your agent</h3>
        <p className="agent-launcher-sub">
          One click — Hearth connects it to this project automatically.
        </p>
      </div>

      {detectFailed ? (
        <div className="agent-detect-failed">
          <span>Couldn't check which agents are installed.</span>
          <Button size="sm" onClick={onRetryDetect}>Retry</Button>
        </div>
      ) : (
        <div className="agent-tiles">
          {tiles.map((tile) => (
            <div key={tile.id} className={`agent-tile agent-tile-${tile.status}`}>
              {tile.status === 'ready' ? (
                <Tooltip content={disabledReason ?? tile.hint}>
                  <button
                    type="button"
                    className="agent-tile-launch"
                    disabled={disabledReason !== null || busy}
                    onClick={() => onLaunch(tile.id)}
                  >
                    <Icon name="play" size={12} />
                    <span className="agent-tile-label">{tile.label}</span>
                    <span className="agent-tile-state">{pending === tile.id ? 'Preparing…' : ''}</span>
                  </button>
                </Tooltip>
              ) : (
                <Tooltip content={tile.hint}>
                  <div className="agent-tile-static" tabIndex={0}>
                    <span className="agent-tile-label">{tile.label}</span>
                    {tile.status === 'checking' ? (
                      <span className="agent-tile-state">Checking…</span>
                    ) : tile.installCommand ? (
                      <Button size="sm" onClick={() => onInstall(tile)} disabled={disabledReason !== null || busy}>
                        Install
                      </Button>
                    ) : (
                      <span className="agent-tile-state">Not installed</span>
                    )}
                  </div>
                </Tooltip>
              )}
              {errors[tile.id] && <div className="agent-tile-error">{errors[tile.id]}</div>}
            </div>
          ))}
        </div>
      )}

      <Tooltip content={describeLauncher('shell', [])}>
        <button
          type="button"
          className="agent-terminal-row"
          disabled={disabledReason !== null || busy}
          onClick={() => onLaunch('shell')}
        >
          Open a plain terminal
        </button>
      </Tooltip>
      {errors.shell && <div className="agent-tile-error">{errors.shell}</div>}

      <div className="agent-launcher-foot">
        <span className="agent-launcher-mode">{modeLabel}</span>
        {gear}
      </div>
    </div>
  );
}
```

Add a `gear` glyph to `ui.tsx`'s ICONS map (12×12 viewBox, matches sibling stroke style):

```tsx
gear: (
  <>
    <circle cx="6" cy="6" r="1.7" />
    <path d="M6 1.5v1.6M6 8.9v1.6M1.5 6h1.6M8.9 6h1.6M2.8 2.8l1.1 1.1M8.1 8.1l1.1 1.1M9.2 2.8L8.1 3.9M3.9 8.1L2.8 9.2" />
  </>
),
```

CSS — append to `agent.css` (tokens only; the Reveal idiom in primitives.css governs hover):

```css
/* Launcher hero (first-run / no session) --------------------------------- */
.agent-launcher {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 20px 14px 10px;
}

.agent-launcher-hero h3 {
  margin: 0 0 2px;
  font-size: var(--text-lg);
}

.agent-launcher-sub {
  margin: 0;
  color: var(--ink-faint);
  font-size: var(--text-sm);
}

.agent-tiles {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.agent-tile {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-1);
  overflow: hidden;
}

.agent-tile-launch,
.agent-tile-static {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  background: none;
  color: var(--ink);
  font-size: var(--text-md);
  text-align: left;
}

.agent-tile-launch {
  cursor: pointer;
}

.agent-tile-launch:hover:not(:disabled) {
  background: var(--bg-2);
}

.agent-tile-launch:disabled {
  color: var(--ink-faint);
  cursor: default;
}

.agent-tile-launch .agent-tile-label {
  flex: 1;
}

.agent-tile-static .agent-tile-label {
  flex: 1;
  color: var(--ink-mute);
}

.agent-tile-missing .agent-tile-label {
  color: var(--ink-faint);
}

.agent-tile-state {
  color: var(--ink-faint);
  font-size: var(--text-xs);
  white-space: nowrap;
}

.agent-tile-error {
  padding: 4px 12px 8px;
  color: var(--err);
  font-size: var(--text-xs);
  white-space: pre-wrap;
}

.agent-detect-failed {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 2px;
  color: var(--ink-mute);
  font-size: var(--text-sm);
}

.agent-terminal-row {
  border: none;
  background: none;
  padding: 4px 2px;
  color: var(--ink-faint);
  font-size: var(--text-sm);
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}

.agent-terminal-row:hover:not(:disabled) {
  color: var(--ink);
}

.agent-launcher-foot {
  margin-top: auto;
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--ink-faint);
  font-size: var(--text-xs);
}
```

Update `agentPanelDetect.test.ts` to import `describeLauncher` from `../src/components/agent/Launcher`, and `AgentPanel.tsx`'s imports for the moved symbols (mechanical — AgentPanel still renders the OLD UI in this task).

- [ ] **Step 5: Run tests + typecheck** — `npx vitest run apps/editor/tests/launcherTiles.test.ts apps/editor/tests/agentPanelDetect.test.ts apps/editor/tests/agentPanelGuards.test.ts && npm run typecheck -w @hearth/editor`. Expected: PASS.

- [ ] **Step 6: Commit** — `git commit -am "Add the agent launcher tile model and presentational component"`

---

### Task 4: AgentPanel three-state rework (launcher | running | exited)

**Files:**
- Create: `apps/editor/src/components/agent/ManualSetup.tsx`
- Modify: `apps/editor/src/components/AgentPanel.tsx` (major rework)
- Modify: `apps/editor/src/styles/panels/agent.css`
- Modify: `apps/editor/tests/agentPanelGuards.test.ts` (drop `modePickerDisabledReason` block)
- Test: existing suites must stay green; guards tests updated

**Interfaces:**
- Consumes: `Launcher`, `launcherTiles`, `LauncherTile`, `AgentLauncher`, `AGENT_LAUNCHER_LABELS`, `INSTALL_COMMANDS` from Task 3; `MenuButton`/`MenuItem` from `ui/Menu`; existing `useAgentSocket`/`planClaudeStart`/`getAgentSessionSummary`.
- Produces: reworked `AgentPanel`; keeps exporting `detectionFailed`, `startDisabledReason`, `shouldRedetectAfterInstall` unchanged. **Deletes** `modePickerDisabledReason` (rationale below) and the always-visible permission blurb.

**Why `modePickerDisabledReason` dies:** AGENT-3's hazard was a mode `<select>` sitting beside an "Open Terminal" button while silently not applying to it. In the new flow the mode control lives in the gear menu and the plain-terminal row carries its own "no MCP server" tooltip — there is no adjacent picker to mislead. Delete the helper and its tests; keep the AGENT-3 explanation on the terminal row's hint (already in `describeLauncher('shell', …)`).

- [ ] **Step 1: Update the guards test first** — in `agentPanelGuards.test.ts`, delete the `modePickerDisabledReason` describe block and its import. Keep `startDisabledReason` / `shouldRedetectAfterInstall` blocks untouched (behavior identical). Run `npx vitest run apps/editor/tests/agentPanelGuards.test.ts` — PASSES still (deleting tests can't fail); this step just locks the contract before the rework.

- [ ] **Step 2: Extract `ManualSetup.tsx`.** Move `AGENT_MODE_ARGS` plus the entire manual-setup JSX (`cliBlock`, `mcpClaudeBlock`, `mcpJsonBlock`, the `<div className="agent-manual-body agent-panel">…</div>` contents including perm table and golden rules) into:

```tsx
/**
 * Manual-setup disclosure: the copy-paste CLI/MCP path for agents the
 * launcher doesn't cover. Content unchanged from the pre-v1.2 panel; only
 * its entry point moved (gear menu → "Manual setup"). Reads the store
 * directly like sibling panels.
 */
import React from 'react';
import { PERMISSION_DOCS, PERMISSION_MODES } from '@hearth/core';
import { useEditor } from '../../store';
import type { AgentPermissionMode } from '../../../server/agentSetup';
import { CodeBlock } from '../ui';

const AGENT_MODE_ARGS: Record<AgentPermissionMode, string> = {
  'read-only': 'read-only',
  'safe-edit': 'safe-edit',
  full: 'safe-edit,code-edit,asset-edit',
  all: 'all',
};

export function ManualSetup() {
  const projectPath = useEditor((s) => s.projectPath);
  const meta = useEditor((s) => s.meta);
  const agentMode = useEditor((s) => s.agentMode);
  const repoRoot = meta?.repoRoot ?? '<hearth repo root>';
  const cliPath = meta?.toolPaths?.cli ?? `${repoRoot}/packages/cli/dist/main.js`;
  const mcpPath = meta?.toolPaths?.mcp ?? `${repoRoot}/packages/mcp-server/dist/main.js`;
  const manualProjectPath = projectPath ?? '<project path>';
  // …cliBlock / mcpClaudeBlock / mcpJsonBlock exactly as they are in
  // AgentPanel.tsx today (lines 313-339), then:
  return (
    <div className="agent-manual-setup">
      <div className="agent-manual-body agent-panel">
        {/* the existing manual-setup children, verbatim (p, h4s, CodeBlocks,
            perm-table, golden-rules) — moved, not rewritten */}
      </div>
    </div>
  );
}
```

(The `{/* … */}` above means MOVE the existing JSX verbatim — it is already written in AgentPanel.tsx:495-556; do not paraphrase or trim it. The collapsible `<button>` toggle does NOT move; the gear menu owns opening now.)

- [ ] **Step 3: Rework `AgentPanel.tsx`.** Full replacement of the component (keep the file-header comment style; keep `Terminal` lazy import, `statusLabel`, `DisabledHint` may be deleted if unused). The complete new component:

```tsx
export function AgentPanel() {
  const projectPath = useEditor((s) => s.projectPath);
  const agentMode = useEditor((s) => s.agentMode);
  const setAgentMode = useEditor((s) => s.setAgentMode);
  const agentDetect = useEditor((s) => s.agentDetect);
  const agentDetecting = useEditor((s) => s.agentDetecting);
  const detectAgent = useEditor((s) => s.detectAgent);
  const log = useEditor((s) => s.log);
  const agent = useAgentSocket();
  const [manualOpen, setManualOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(true);
  // After a session exits the terminal stays up (scrollback + exit code are
  // the evidence of what happened); "Switch agent" is the explicit way back.
  const [backToLauncher, setBackToLauncher] = useState(false);
  const [pending, setPending] = useState<AgentLauncher | null>(null);
  const [tileErrors, setTileErrors] = useState<Partial<Record<AgentLauncher, string>>>({});
  const [detectFailed, setDetectFailed] = useState(false);
  const wasDetecting = useRef(agentDetecting);
  const installEpoch = useRef<number | null>(null);

  useEffect(() => {
    void detectAgent();
    // Detect once per mount; the gear's Re-detect covers "I just installed it".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (detectionFailed(wasDetecting.current, agentDetecting, agentDetect)) {
      setDetectFailed(true);
    } else if (agentDetecting) {
      setDetectFailed(false);
    }
    wasDetecting.current = agentDetecting;
  }, [agentDetecting, agentDetect]);

  const status = agent.session.status;
  const running = status === 'running';
  const showLauncher = status === 'idle' || (status === 'exited' && backToLauncher);
  const ollamaModels = agentDetect?.ollama.models ?? [];
  const startReason = startDisabledReason(running, projectPath);

  async function launch(launcher: AgentLauncher) {
    if (!projectPath || pending !== null) return;
    setTileErrors({});
    if (launcher === 'shell') {
      if (agent.start('shell')) setBackToLauncher(false);
      return;
    }
    setPending(launcher);
    try {
      // Permissioning happens in prepare, not the spawn: prepare writes the
      // hearth entry (with --mode) into the tool's OWN config, which the bare
      // interactive CLI picks up itself (subscription safety).
      const result = await apiPrepareAgent(projectPath, agentMode, launcher);
      const decision = planClaudeStart(result);
      if (!decision.shouldStart) {
        // Never fall through to agent.start(): a stale config could carry a
        // MORE permissive mode than the one just selected.
        setTileErrors({ [launcher]: decision.errorMessage });
        log('error', 'command', `Agent setup failed: ${decision.errorMessage}`);
        return;
      }
      if (agent.start(launcher, agentMode)) setBackToLauncher(false);
    } finally {
      setPending(null);
    }
  }

  function install(tile: LauncherTile) {
    // Run the official install visibly in the terminal; if the shell could
    // not start (socket down), don't fire the command into the void.
    if (!tile.installCommand) return;
    if (agent.start('shell')) {
      agent.sendInput(`${tile.installCommand}\r`);
      installEpoch.current = getAgentSessionSummary().epoch;
      setBackToLauncher(false);
    }
  }

  // When the install session exits, re-detect AND return to the launcher so
  // the freshly installed agent shows up ready to click. Epoch-matched so a
  // later unrelated session's exit never triggers it.
  useEffect(() => {
    if (shouldRedetectAfterInstall(installEpoch.current, agent.session)) {
      installEpoch.current = null;
      setBackToLauncher(true);
      void detectAgent();
    }
  }, [agent.session, detectAgent]);

  const modeReason = running ? 'Stop the current session first to change mode.' : null;
  const gearItems: MenuItem[] = [
    ...AGENT_MODE_LADDER.map((mode) => ({
      label: AGENT_MODE_LABELS[mode],
      checked: agentMode === mode,
      disabled: modeReason !== null,
      disabledReason: modeReason ?? undefined,
      onSelect: () => setAgentMode(mode),
    })),
    { separator: true as const },
    { label: 'Re-detect agents', onSelect: () => void detectAgent() },
    { label: 'Manual setup', checked: manualOpen, onSelect: () => setManualOpen((open) => !open) },
  ];
  const gear = (
    <MenuButton
      trigger={<Icon name="gear" size={12} />}
      label="Agent settings"
      items={gearItems}
      align="right"
      triggerClassName="btn btn-ghost btn-sm"
    />
  );

  const sessionLabel = agent.session.command ? AGENT_LAUNCHER_LABELS[agent.session.command] : 'Agent';

  return (
    <div className="agent-panel-root">
      {showLauncher ? (
        <Launcher
          tiles={launcherTiles(agentDetect, agentDetecting, ollamaModels)}
          detectFailed={detectFailed}
          disabledReason={startReason}
          pending={pending}
          errors={tileErrors}
          modeLabel={AGENT_MODE_LABELS[agentMode]}
          gear={gear}
          onLaunch={(l) => void launch(l)}
          onInstall={install}
          onRetryDetect={() => void detectAgent()}
        />
      ) : (
        <>
          <div className="panel-toolbar agent-header">
            <span className={`agent-status-dot agent-status-${status}`} aria-hidden="true" />
            <span className="agent-header-title">{sessionLabel}</span>
            <span className={`agent-status agent-status-${status}`}>{statusLabel(agent.session)}</span>
            <span style={{ flex: 1 }} />
            {status === 'exited' && (
              <>
                <Button size="sm" onClick={() => agent.session.command && void launch(agent.session.command)} disabled={pending !== null}>
                  Launch again
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setBackToLauncher(true)}>
                  Switch agent
                </Button>
              </>
            )}
            <Button variant="danger" size="sm" onClick={() => agent.stop()} disabled={!running}>
              Stop
            </Button>
            {gear}
          </div>
          <div className="agent-terminal-pane">
            <Suspense fallback={<div className="empty-state">Loading terminal…</div>}>
              <Terminal onData={agent.sendInput} onResize={agent.sendResize} />
            </Suspense>
          </div>
          <div className="agent-activity">
            <button
              type="button"
              className="agent-activity-toggle"
              aria-expanded={activityOpen}
              onClick={() => setActivityOpen((open) => !open)}
            >
              <Icon name="chevron" size={10} />
              <span>Activity</span>
            </button>
            {activityOpen && <Timeline />}
          </div>
        </>
      )}
      {manualOpen && <ManualSetup />}
    </div>
  );
}
```

Deletions from the old file: the launcher/mode `<select>`s, `Install Claude Code` branches, `INSTALL_COMMAND`, `AGENT_MODE_HINTS`, `AGENT_MODE_SUMMARIES`, `AGENT_MODE_ARGS` (moved), `modePickerDisabledReason`, `describeLauncher` + launcher constants (moved in Task 3), the `.agent-mode-hint` block, the `.agent-prepare-error` strip (tile errors replace it), the manual-setup toggle bar, `DisabledHint` (Launcher/Tooltip covers the remaining cases — delete if nothing else uses it), the `manualProjectPath`/`cliBlock`/`mcp*Block` locals (moved). Keep `AGENT_MODE_LADDER`/`AGENT_MODE_LABELS` (gear + footer chip use them).

**Terminal remount caveat:** `Terminal` now unmounts when the launcher shows. This is the SAME lifecycle as the panel being closed/reopened in dockview (already supported — scrollback replays via the write-cursor); verify by launching, switching to launcher after exit, and relaunching: scrollback must replay, no double-echo.

- [ ] **Step 4: CSS rework** — in `agent.css`, replace the `.agent-body` / `.agent-side-rail` / `.agent-toolbar` / `.agent-mode-hint` / `.agent-mode-details*` / `.agent-prepare-error` / `.agent-manual-toggle` rules with the vertical-stack layout (KEEP: `.agent-panel` prose rules, `.code-block`, `.perm-table`, `.golden-rules`, all `.timeline-*` and `.agent-timeline*` rules, `.agent-xterm`, `.agent-status*` text colors):

```css
.agent-header .agent-header-title {
  font-weight: 600;
  font-size: var(--text-sm);
}

.agent-status-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-faint);
}

.agent-status-dot.agent-status-running {
  background: var(--ok);
}

.agent-status-dot.agent-status-exited {
  background: var(--ink-mute);
}

.agent-terminal-pane {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  background: var(--bg-0);
  padding: 6px 8px;
}

/* Collapsible Activity section under the terminal: the journal timeline plus
   Checkpoint / Review / Restore. Collapsing hands its height to the terminal. */
.agent-activity {
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--border);
  background: var(--bg-1);
}

.agent-activity:has(.agent-timeline) {
  flex: 0 1 40%;
}

.agent-activity-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  height: var(--ctl-h);
  padding: 0 10px;
  border: none;
  background: var(--bg-1);
  color: var(--ink-mute);
  font-size: var(--text-sm);
  font-weight: 600;
  cursor: pointer;
  flex: none;
}

.agent-activity-toggle:hover {
  background: var(--bg-2);
  color: var(--ink);
}

.agent-activity-toggle svg {
  transition: transform var(--t) var(--ease-out);
}

.agent-activity-toggle[aria-expanded='true'] svg {
  transform: rotate(90deg);
}

.agent-manual-setup {
  flex: none;
  border-top: 1px solid var(--border);
  max-height: 45%;
  display: flex;
  flex-direction: column;
}
```

(If `:has()` trips the style gates or vendored tooling, use a `data-open` attribute on `.agent-activity` set from `activityOpen` instead — same effect, pick whichever the codebase already uses; grep for `:has(` in `src/styles` first and follow suit.)

Also: the timeline's three buttons already wrap (`.agent-timeline-toolbar { flex-wrap: wrap }`) — keep that. Check `.agent-timeline` still fills: it's `height: 100%` inside a flex column — verify visually in Step 6.

- [ ] **Step 5: Run the full editor suite + typecheck** — `npx vitest run apps/editor && npm run typecheck -w @hearth/editor`. Expected: PASS (fix any copy-sweep/style-gate hits by adjusting copy/CSS, not the gates).

- [ ] **Step 6: Visual smoke in the dev editor** — `cd apps/editor && npm run dev`, open an example project in a browser (per the index.md headless-editor technique if no human eyes): confirm (a) agent dock on the far right at ~380px, (b) launcher hero with tiles, (c) launching Claude Code (or the plain terminal if no agent installed) flips to the session view, (d) Activity collapses/expands, (e) gear menu changes mode and toggles Manual setup. Fix what's broken before committing.

- [ ] **Step 7: Commit** — `git commit -am "Rework the Agent panel into a launcher-first three-state flow"`

---

### Task 5: Docs update

**Files:**
- Modify: `docs/agent-panel.md`
- Check-and-touch: `grep -rn "bottom dock\|bottom panel" docs/*.md` — update any doc that states the Agent panel's location or first-run flow (likely `docs/editor.md` if it exists).

**Interfaces:** none — prose only. Engine `docs/*.md` is the source of truth (the website's copies are generated; do not touch the website repo).

- [ ] **Step 1: Update `docs/agent-panel.md`:** the panel's location (own right-hand dock beside the Inspector; saved layouts migrate automatically), the first-run flow (Launch your agent → tiles → one click; permission mode defaults to Safe edit, changed from the gear; Manual setup behind the gear), the generalized install flow (inline Install for launchers with a known installer, visible in the terminal; Hermes points at connect-hermes.md), the Activity section (below the terminal, collapsible, Checkpoint/Review/Restore live there). Keep the subscription-safety position section verbatim. Write plain human prose — no em-dash chains, no marketing.
- [ ] **Step 2: Verify no stale references** — `grep -rn "Install Claude Code\|bottom" docs/agent-panel.md` reads consistently with the new UI; `npx vitest run apps/editor/tests/copySweep.test.ts` still green (it may scan docs).
- [ ] **Step 3: Commit** — `git commit -am "Document the Agent panel's right dock and launcher flow"`

---

### Task 6: Full gate + packaged-app verification

**Files:** none new (fixes only if the gate finds problems).

- [ ] **Step 1: Full suite + typecheck** — from repo root: `npx vitest run` and `npm run typecheck`. Expected: all green (2765+ tests).
- [ ] **Step 2: Binary/NUL scan (Wave N lesson)** — `git diff v1.1.0 --numstat | awk '$1=="-"&&$2=="-"'` must print nothing; `grep -rIl $'\x00' apps/editor/src packages/*/src | grep -v node_modules` must print nothing.
- [ ] **Step 3: Examples regen check** — regen examples per `packages/examples/generate.mjs` and confirm `git status` stays clean (nothing in this wave should touch them; a dirty tree means something leaked).
- [ ] **Step 4: Electron smoke** — `HEARTH_SMOKE=1 npm run app -w @hearth/editor` exits green (builds the editor + boots the packaged-shape app headlessly).
- [ ] **Step 5: Packaged-app drive** — `npm run app:dist -w @hearth/editor`, launch the built app from `apps/editor/release-app` output, and drive the panel: first-run launcher renders, detection is honest (this app is GUI-launched — the exact PATH-bug environment), launch works, layout persists and a pre-seeded v1 layout (copy a `hearth.layout.*` localStorage value stamped `"version":1`) migrates the agent to the right dock. Screenshot the result for the run note. Anything that only fails here is exactly the class of bug this spec exists for — fix it, don't ship around it.
- [ ] **Step 6: Commit any fixes** — plain-voice messages, one concern per commit.

---

## Self-review (done at plan time)

- Spec coverage: layout §1 → Tasks 1–2; states §2 → Tasks 3–4; code shape §3 → Tasks 3–4 (split into Launcher/ManualSetup/slim panel); errors §4 → Task 4 (tile errors, retry row, install-visible terminal); testing §5 → every task's steps + Task 6; docs → Task 5.
- Types consistent: `LauncherTile`/`AgentLauncher`/`launcherTiles` defined in Task 3, consumed with same signatures in Task 4; `RestoredLayout.migrateAgentDock` defined Task 1, consumed Task 2.
- Known judgment calls the implementer may exercise: dockview reference-less `{direction:'right'}` fallback (Task 2 step 3d), `:has()` vs `data-open` (Task 4 step 4), install package-name verification (Task 3 step 1).
