import React, { Suspense, lazy, useEffect, useState } from 'react';
import { PERMISSION_DOCS, PERMISSION_MODES } from '@hearth/core';
import { useEditor } from '../store';
import { apiPrepareAgent } from '../api';
import type { AgentPermissionMode } from '../../server/agentSetup';
import { CodeBlock, Icon } from './ui';
import { Timeline } from './agent/Timeline';
import { planClaudeStart, useAgentSocket, type AgentSessionSummary } from './agent/useAgentSocket';

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

  useEffect(() => {
    void detectAgent();
    // Detect once per mount; the Re-detect button covers "I just installed it".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const running = agent.session.status === 'running';
  const claudeFound = agentDetect?.claude.found ?? false;
  const codexFound = agentDetect?.codex.found ?? false;
  const launcherFound = agentLauncher === 'shell' || (agentLauncher === 'claude' ? claudeFound : codexFound);
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
    if (agent.start('shell')) agent.sendInput(`${INSTALL_COMMAND}\r`);
  }

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
        <select
          className="select"
          value={agentLauncher}
          onChange={(e) => {
            setAgentLauncher(e.target.value as AgentLauncher);
            setPrepareError(null);
          }}
          title="Choose which local agent CLI to launch"
        >
          <option value="claude">{AGENT_LAUNCHER_LABELS.claude}</option>
          <option value="codex">{AGENT_LAUNCHER_LABELS.codex}</option>
          <option value="shell">{AGENT_LAUNCHER_LABELS.shell}</option>
        </select>

        <select
          className="select"
          value={agentMode}
          onChange={(e) => setAgentMode(e.target.value as AgentPermissionMode)}
          title={AGENT_MODE_HINTS[agentMode]}
        >
          {AGENT_MODE_LADDER.map((mode) => (
            <option key={mode} value={mode}>
              {AGENT_MODE_LABELS[mode]}
            </option>
          ))}
        </select>

        {agentDetecting && agentLauncher !== 'shell' ? (
          <button className="btn btn-primary btn-sm" disabled>
            Checking…
          </button>
        ) : launcherFound ? (
          <button className="btn btn-primary btn-sm" onClick={() => void startAgent()} disabled={!projectPath}>
            {agentLauncher === 'shell' ? 'Open Terminal' : 'Start agent'}
          </button>
        ) : agentLauncher === 'claude' ? (
          <>
            <button className="btn btn-primary btn-sm" onClick={installClaude} disabled={!projectPath}>
              Install Claude Code
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void detectAgent()}
              title="Re-check whether the claude CLI is on PATH"
            >
              Re-detect
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-primary btn-sm" disabled>
              Codex not found
            </button>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => void detectAgent()}
              title="Re-check whether the codex CLI is on PATH"
            >
              Re-detect
            </button>
          </>
        )}

        <span className="panel-divider" />

        <button className="btn btn-danger btn-sm" onClick={() => agent.stop()} disabled={!running}>
          Stop
        </button>

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
