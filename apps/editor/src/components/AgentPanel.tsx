import React, { Suspense, lazy, useEffect, useRef, useState, type ReactElement } from 'react';
import { PERMISSION_DOCS, PERMISSION_MODES } from '@hearth/core';
import { useEditor } from '../store';
import { apiPrepareAgent } from '../api';
import type { AgentPermissionMode, DetectAgentsResult } from '../../server/agentSetup';
import { CodeBlock, Icon } from './ui';
import { Button } from './ui/Button';
import { Tooltip } from './ui/Tooltip';
import { Timeline } from './agent/Timeline';
import { getAgentSessionSummary, planClaudeStart, useAgentSocket, type AgentSessionSummary } from './agent/useAgentSocket';

// xterm (+ its addon and css) is a heavy dependency that only the Agent
// panel needs; keeping it out of the main chunk mirrors CodePanel's lazy
// CodeEditor. React.lazy needs a default export, so map Terminal's named
// export — this doesn't change component identity across suspense
// boundaries (Terminal itself is only ever mounted once per AgentPanel
// lifetime; see Terminal.tsx's mount/scrollback-replay comment).
const Terminal = lazy(() => import('./agent/Terminal').then((m) => ({ default: m.Terminal })));

// The editor's 4-tier picker onto the MCP server's real permission modes
// (agentSetup.ts's AgentPermissionMode/MODE_ARGS). Labels + hints are built
// from the same PERMISSION_DOCS copy the manual-setup table below uses —
// "full" and "all" compose theirs from the tiers they actually grant rather
// than inventing new claims, so "full" never overpromises past what it is:
// everything except build/export.
const AGENT_MODE_LADDER: readonly AgentPermissionMode[] = ['read-only', 'safe-edit', 'full', 'all'];

const AGENT_MODE_LABELS: Record<AgentPermissionMode, string> = {
  'read-only': 'Read-only',
  'safe-edit': 'Safe edit',
  full: 'Full (no build)',
  all: 'All (incl. build)',
};

const AGENT_MODE_HINTS: Record<AgentPermissionMode, string> = {
  'read-only': PERMISSION_DOCS['read-only'],
  'safe-edit': PERMISSION_DOCS['safe-edit'],
  full: `${PERMISSION_DOCS['safe-edit']} ${PERMISSION_DOCS['code-edit']} ${PERMISSION_DOCS['asset-edit']}`,
  all: PERMISSION_MODES.map((mode) => PERMISSION_DOCS[mode]).join(' '),
};

const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
type AgentLauncher = 'claude' | 'codex' | 'shell';

const AGENT_LAUNCHER_LABELS: Record<AgentLauncher, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  shell: 'Terminal / other CLI',
};

/**
 * True when a just-completed detect attempt failed outright (network error,
 * malformed response) rather than succeeding and genuinely finding neither
 * CLI on PATH — `apiDetectAgents` returns `null` for both cases, but they
 * call for different next actions (retry vs. install), so the panel needs
 * to tell them apart. `wasDetecting`/`isDetecting` bracket one attempt;
 * `result` is the store's `agentDetect` value once `isDetecting` goes false.
 */
export function detectionFailed(
  wasDetecting: boolean,
  isDetecting: boolean,
  result: DetectAgentsResult | null,
): boolean {
  return wasDetecting && !isDetecting && result === null;
}

/**
 * Why the primary launch action (Start agent / Open Terminal) — and the
 * launcher/mode selects that feed it — must be disabled right now, or null
 * when it's safe to click. `startPty` unconditionally kills any existing pty
 * before spawning the new one, so once a session is running, switching the
 * launcher dropdown must not silently re-enable a clickable button that
 * would kill the live session with no confirmation (AGENT-1 / L-089).
 */
export function startDisabledReason(running: boolean, projectPath: string | null): string | null {
  if (running) return 'Stop the current session first.';
  if (!projectPath) return 'Open a project first.';
  return null;
}

/**
 * The permission-mode picker only matters for the Claude launcher — the
 * server's `startPty` never reads `mode` for codex/shell (it's passed on the
 * pty-start frame purely for the server's own logging). Presenting it fully
 * enabled for those two launchers looks actionable but is inert
 * (AGENT-3 / L-091); this names why so the picker can be disabled with a
 * reason instead of silently doing nothing.
 */
export function modePickerDisabledReason(launcher: AgentLauncher): string | null {
  if (launcher === 'claude') return null;
  return `${AGENT_LAUNCHER_LABELS[launcher]} doesn't read a permission mode — this only applies to Claude Code.`;
}

/**
 * True when the install-Claude shell session just finished — time to
 * re-detect automatically so the "Install Claude Code" button resolves to
 * "Start agent" (or an honest failure) without a manual Re-detect click.
 * `installEpoch` is the pty epoch captured when the install session was
 * started (null when no install is pending); the epoch match ensures a
 * LATER unrelated session's exit doesn't trigger a spurious re-detect.
 */
export function shouldRedetectAfterInstall(
  installEpoch: number | null,
  session: Pick<AgentSessionSummary, 'epoch' | 'status'>,
): boolean {
  return installEpoch !== null && session.epoch === installEpoch && session.status === 'exited';
}

function statusLabel(session: AgentSessionSummary): string {
  switch (session.status) {
    case 'idle':
      return 'Idle';
    case 'running':
      return session.command ? `Running ${session.command}` : 'Running';
    case 'exited':
      if (session.errorMessage) return session.command ? `Failed to start ${session.command}` : 'Failed to start';
      return session.exitCode != null ? `Exited (code ${session.exitCode})` : 'Exited';
    default:
      return '';
  }
}

/**
 * Wraps a disabled control in a Tooltip + focusable span, matching
 * Inspector.tsx's `AutotileRuleFields` "disabledReason" pattern — a disabled
 * native control (`<select disabled>`, `<button disabled>`) doesn't
 * reliably surface hover/focus for its own Tooltip, so the wrapper carries
 * it instead. Renders `children` bare when there's no reason.
 */
function DisabledHint({ reason, children }: { reason: string | null; children: ReactElement }) {
  if (!reason) return children;
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} style={{ display: 'inline-flex' }}>
        {children}
      </span>
    </Tooltip>
  );
}

export function AgentPanel() {
  const projectPath = useEditor((s) => s.projectPath);
  const meta = useEditor((s) => s.meta);
  const agentMode = useEditor((s) => s.agentMode);
  const setAgentMode = useEditor((s) => s.setAgentMode);
  const agentDetect = useEditor((s) => s.agentDetect);
  const agentDetecting = useEditor((s) => s.agentDetecting);
  const detectAgent = useEditor((s) => s.detectAgent);
  const log = useEditor((s) => s.log);
  const agent = useAgentSocket();
  const [manualOpen, setManualOpen] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [agentLauncher, setAgentLauncher] = useState<AgentLauncher>('claude');
  const [detectFailed, setDetectFailed] = useState(false);
  const wasDetecting = useRef(agentDetecting);
  // Epoch of a pending install-Claude shell session (null = none pending);
  // when THAT session exits, re-detect automatically (see the effect below).
  const installEpoch = useRef<number | null>(null);

  useEffect(() => {
    void detectAgent();
    // Detect once per mount; the Re-detect button covers "I just installed it".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (detectionFailed(wasDetecting.current, agentDetecting, agentDetect)) {
      setDetectFailed(true);
    } else if (agentDetecting) {
      // A new attempt just started — clear any stale failure from last time.
      setDetectFailed(false);
    }
    wasDetecting.current = agentDetecting;
  }, [agentDetecting, agentDetect]);

  const running = agent.session.status === 'running';
  const claudeFound = agentDetect?.claude.found ?? false;
  const codexFound = agentDetect?.codex.found ?? false;
  const launcherFound = agentLauncher === 'shell' || (agentLauncher === 'claude' ? claudeFound : codexFound);
  // Switching launcher/mode while a session runs must never re-enable a
  // clickable Start action that would silently kill the live pty
  // (AGENT-1 / L-089) — so the selects that feed it are disabled too.
  const launcherSwitchReason = running ? 'Stop the current session first to switch launcher.' : null;
  const startReason = startDisabledReason(running, projectPath);
  const modeReason = running
    ? 'Stop the current session first to change mode.'
    : modePickerDisabledReason(agentLauncher);
  const launcherHint =
    agentLauncher === 'claude'
      ? 'Claude Code sets up its Hearth connection automatically.'
      : agentLauncher === 'codex'
        ? 'Codex launches in this project — see Manual setup below for other clients.'
        : 'Use the project terminal for OpenCode, Hermes, or any other shell-native agent.';

  async function startAgent() {
    if (!projectPath) return;
    if (agentLauncher !== 'claude') {
      setPrepareError(null);
      agent.start(agentLauncher);
      return;
    }

    // Permissioning happens here, not in the spawn: prepare writes the
    // hearth entry (with --mode) into .mcp.json, which the bare interactive
    // `claude` picks up itself. The mode rides along on pty-start only so
    // the server sees what was requested.
    const result = await apiPrepareAgent(projectPath, agentMode);
    const decision = planClaudeStart(result);
    if (!decision.shouldStart) {
      // Do NOT fall through to agent.start(): a corrupted/stale .mcp.json
      // from a previous session could carry a MORE permissive mode than the
      // one just selected, and that stale grant must never silently win.
      setPrepareError(decision.errorMessage);
      log('error', 'command', `Agent setup failed: ${decision.errorMessage}`);
      return;
    }
    setPrepareError(null);
    agent.start('claude', agentMode);
  }

  function installClaude() {
    // Run the official install visibly in the terminal; if the shell could
    // not start (socket down), don't fire the command into the void.
    if (agent.start('shell')) {
      agent.sendInput(`${INSTALL_COMMAND}\r`);
      // Capture the just-started session's epoch (agent.start committed it
      // synchronously to the external store; this render's `agent.session`
      // is still the pre-start snapshot, so read the store directly).
      installEpoch.current = getAgentSessionSummary().epoch;
    }
  }

  // When the install-Claude session exits, re-detect automatically so the
  // Install button resolves to "Start agent" (or an honest failure) without
  // a manual Re-detect click. Epoch-matched: a later unrelated session's
  // exit never triggers a spurious re-detect.
  useEffect(() => {
    if (shouldRedetectAfterInstall(installEpoch.current, agent.session)) {
      installEpoch.current = null;
      void detectAgent();
    }
  }, [agent.session, detectAgent]);

  // --- Manual-setup content (unchanged from the pre-terminal panel) --------
  // In the packaged desktop app these are self-contained single-file bundles
  // shipped with the app; from a repo checkout they're the built packages.
  const repoRoot = meta?.repoRoot ?? '<hearth repo root>';
  const cliPath = meta?.toolPaths?.cli ?? `${repoRoot}/packages/cli/dist/main.js`;
  const mcpPath = meta?.toolPaths?.mcp ?? `${repoRoot}/packages/mcp-server/dist/main.js`;
  const manualProjectPath = projectPath ?? '<project path>';

  const cliBlock = [
    `alias hearth="node ${cliPath}"`,
    `cd ${manualProjectPath}`,
    `hearth inspect project --json      # learn the project`,
    `hearth snapshot                    # checkpoint before changes`,
    `hearth inspect scene <scene> --json`,
    `hearth validate --json             # after changes`,
    `hearth diff                        # review what changed`,
  ].join('\n');

  const mcpClaudeBlock = `claude mcp add hearth -- node ${mcpPath} --project ${manualProjectPath}`;

  const mcpJsonBlock = JSON.stringify(
    {
      mcpServers: {
        hearth: {
          command: 'node',
          args: [mcpPath, '--project', manualProjectPath],
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="agent-panel-root">
      <div className="panel-toolbar agent-toolbar">
        <Tooltip content={launcherSwitchReason ?? 'Choose which local agent CLI to launch'}>
          <span tabIndex={running ? 0 : -1} style={{ display: 'inline-flex' }}>
            <select
              className="select"
              value={agentLauncher}
              disabled={running}
              onChange={(e) => {
                setAgentLauncher(e.target.value as AgentLauncher);
                setPrepareError(null);
              }}
            >
              <option value="claude">{AGENT_LAUNCHER_LABELS.claude}</option>
              <option value="codex">{AGENT_LAUNCHER_LABELS.codex}</option>
              <option value="shell">{AGENT_LAUNCHER_LABELS.shell}</option>
            </select>
          </span>
        </Tooltip>

        {/* The permission-mode explanation is already shown as visible text
            below the toolbar (AGENT_MODE_HINTS[agentMode]); no native title
            unless it's disabled (AGENT-3 / L-091 non-Claude launchers, or a
            running session — see modeReason above), in which case that
            reason IS the tooltip. */}
        <DisabledHint reason={modeReason}>
          <select
            className="select"
            value={agentMode}
            disabled={modeReason !== null}
            onChange={(e) => setAgentMode(e.target.value as AgentPermissionMode)}
          >
            {AGENT_MODE_LADDER.map((mode) => (
              <option key={mode} value={mode}>
                {AGENT_MODE_LABELS[mode]}
              </option>
            ))}
          </select>
        </DisabledHint>

        {agentDetecting && agentLauncher !== 'shell' ? (
          <Button variant="primary" size="sm" disabled>
            Checking…
          </Button>
        ) : launcherFound ? (
          <DisabledHint reason={startReason}>
            <Button variant="primary" size="sm" onClick={() => void startAgent()} disabled={startReason !== null}>
              {agentLauncher === 'shell' ? 'Open Terminal' : 'Start agent'}
            </Button>
          </DisabledHint>
        ) : detectFailed ? (
          <>
            <Button variant="primary" size="sm" disabled>
              Couldn't check for {AGENT_LAUNCHER_LABELS[agentLauncher]}
            </Button>
            <Tooltip content={`Re-check whether the ${agentLauncher} CLI is on PATH`}>
              <Button variant="ghost" size="sm" onClick={() => void detectAgent()}>
                Re-detect
              </Button>
            </Tooltip>
          </>
        ) : agentLauncher === 'claude' ? (
          <>
            {/* Same AGENT-1 guard as Start agent: installClaude() spawns a
                shell pty, so an unguarded click while ANY session runs —
                including the install session itself — would silently kill it. */}
            <DisabledHint reason={startReason}>
              <Button variant="primary" size="sm" onClick={installClaude} disabled={startReason !== null}>
                Install Claude Code
              </Button>
            </DisabledHint>
            <Tooltip content="Re-check whether the claude CLI is on PATH">
              <Button variant="ghost" size="sm" onClick={() => void detectAgent()}>
                Re-detect
              </Button>
            </Tooltip>
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled>
              Codex not found
            </Button>
            <Tooltip content="Re-check whether the codex CLI is on PATH">
              <Button variant="ghost" size="sm" onClick={() => void detectAgent()}>
                Re-detect
              </Button>
            </Tooltip>
          </>
        )}

        <span className="panel-divider" />

        <Button variant="danger" size="sm" onClick={() => agent.stop()} disabled={!running}>
          Stop
        </Button>

        <span style={{ flex: 1 }} />

        <span className={`agent-status agent-status-${agent.session.status}`}>{statusLabel(agent.session)}</span>
      </div>

      {prepareError && <div className="agent-prepare-error">Agent setup failed: {prepareError}</div>}

      <div className="agent-mode-hint">
        {AGENT_MODE_HINTS[agentMode]} {launcherHint}
      </div>

      <div className="agent-body">
        <div className="agent-terminal-pane">
          <Suspense fallback={<div className="empty-state">Loading terminal…</div>}>
            <Terminal onData={agent.sendInput} onResize={agent.sendResize} />
          </Suspense>
        </div>
        <div className="agent-side-rail">
          <Timeline />
        </div>
      </div>

      <div className="agent-manual-setup">
        <button
          type="button"
          className="agent-manual-toggle"
          onClick={() => setManualOpen((open) => !open)}
          aria-expanded={manualOpen}
        >
          <Icon name="chevron" size={10} />
          <span>Manual setup</span>
        </button>
        {manualOpen && (
          <div className="agent-manual-body agent-panel">
            <p>
              Hearth is agent-native: everything this editor does goes through the same command system that the{' '}
              <code>hearth</code> CLI and the MCP server expose. Start Claude Code or Codex here, or open the terminal
              for OpenCode, Hermes, and other shell-native agents. New projects also get AGENTS.md / CLAUDE.md with
              these instructions baked in.
            </p>

            <h4>CLI (any agent with a shell)</h4>
            <CodeBlock code={cliBlock} />

            <h4>MCP: Claude Code</h4>
            <CodeBlock code={mcpClaudeBlock} />

            <h4>MCP: generic clients</h4>
            <CodeBlock code={mcpJsonBlock} />

            <h4>Permission modes</h4>
            <p>
              Sessions are granted an escalating set of modes (CLI <code>--allow</code>, MCP server{' '}
              <code>--mode</code>). This editor grants all modes; narrow an agent's grant to what its task needs.
            </p>
            <table className="perm-table">
              <thead>
                <tr>
                  <th>Mode</th>
                  <th>Allows</th>
                </tr>
              </thead>
              <tbody>
                {PERMISSION_MODES.map((mode) => (
                  <tr key={mode}>
                    <td>{mode}</td>
                    <td>{PERMISSION_DOCS[mode]}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <h4>The golden rules (what good agents do)</h4>
            <ol className="golden-rules">
              <li>
                <strong>Checkpoint</strong> before changing anything, so you can review and restore.
              </li>
              <li>
                <strong>Inspect, don't guess</strong>: read the project through structured commands instead of
                assuming its shape.
              </li>
              <li>
                <strong>Edit through commands</strong>, never by hand-editing hearth.json or scene files (scripts in
                scripts/ are normal code and fair game).
              </li>
              <li>
                <strong>Validate</strong> after changes and fix what broke.
              </li>
              <li>
                <strong>Review</strong> the changes at the end and summarize what changed.
              </li>
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
