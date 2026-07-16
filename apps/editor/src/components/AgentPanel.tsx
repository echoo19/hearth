import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useEditor } from '../store';
import { apiPrepareAgent } from '../api';
import type { AgentPermissionMode, DetectAgentsResult } from '../../server/agentSetup';
import { Icon } from './ui';
import { Button } from './ui/Button';
import { MenuButton, type MenuItem } from './ui/Menu';
import {
  AGENT_LAUNCHER_LABELS,
  Launcher,
  launcherTiles,
  type AgentLauncher,
  type LauncherTile,
} from './agent/Launcher';
import { ManualSetup } from './agent/ManualSetup';
import { Timeline } from './agent/Timeline';
import { getAgentSessionSummary, planClaudeStart, useAgentSocket, type AgentSessionSummary } from './agent/useAgentSocket';

// xterm (+ its addon and css) is a heavy dependency that only the Agent
// panel needs; keeping it out of the main chunk mirrors CodePanel's lazy
// CodeEditor. React.lazy needs a default export, so map Terminal's named
// export — this doesn't change component identity across suspense
// boundaries (Terminal itself is only ever mounted once per session view;
// see Terminal.tsx's mount/scrollback-replay comment).
const Terminal = lazy(() => import('./agent/Terminal').then((m) => ({ default: m.Terminal })));

// The editor's 4-tier picker onto the MCP server's real permission modes
// (agentSetup.ts's AgentPermissionMode/MODE_ARGS). The gear menu and the
// launcher footer chip both read these labels; the full enumeration and the
// `--mode` expansion live in ManualSetup now.
const AGENT_MODE_LADDER: readonly AgentPermissionMode[] = ['read-only', 'safe-edit', 'full', 'all'];

const AGENT_MODE_LABELS: Record<AgentPermissionMode, string> = {
  'read-only': 'Read-only',
  'safe-edit': 'Safe edit',
  full: 'Full (no build)',
  all: 'All (incl. build)',
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
 * Why launching (a tile, or "Open a plain terminal") must be disabled right
 * now, or null when it's safe to click. `startPty` unconditionally kills any
 * existing pty before spawning the new one, so once a session is running the
 * launcher must not offer a clickable button that would kill the live session
 * with no confirmation (AGENT-1 / L-089).
 */
export function startDisabledReason(running: boolean, projectPath: string | null): string | null {
  if (running) return 'Stop the current session first.';
  if (!projectPath) return 'Open a project first.';
  return null;
}

/**
 * True when the install shell session just finished — time to re-detect
 * automatically so the just-installed agent's tile resolves from "Install"
 * to a ready launch tile without a manual Re-detect click. `installEpoch`
 * is the pty epoch captured when the install session was started (null when
 * no install is pending); the epoch match ensures a LATER unrelated
 * session's exit doesn't trigger a spurious re-detect.
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
 * The Agent panel is a three-state machine driven by the pty session status
 * plus one `backToLauncher` escape hatch:
 *
 *  - launcher  (status idle, OR exited + user hit "Switch agent"): the
 *    first-run tiles + gear. Detection runs once per mount here.
 *  - running   (status running): the session view — header, live terminal,
 *    collapsible Activity timeline.
 *  - exited    (status exited): the session view stays up (scrollback + exit
 *    code are the evidence of what happened); the header gains "Launch again"
 *    and "Switch agent" — the latter is the explicit way back to the launcher.
 *
 * The gear menu (mode ladder, Re-detect, Manual setup) is shared by both the
 * launcher footer and the session header. Manual setup renders below either.
 */
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
  // Epoch of a pending install shell session (null = none pending); when THAT
  // session exits, re-detect automatically and return to the launcher.
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
      // A new attempt just started — clear any stale failure from last time.
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
    if (!projectPath || pending !== null) return;
    if (!tile.installCommand) return;
    if (agent.start('shell')) {
      agent.sendInput(`${tile.installCommand}\r`);
      // Capture the just-started session's epoch (agent.start committed it
      // synchronously to the external store; this render's `agent.session`
      // is still the pre-start snapshot, so read the store directly).
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
                <Button
                  size="sm"
                  onClick={() => agent.session.command && void launch(agent.session.command)}
                  disabled={pending !== null || !projectPath}
                >
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
          {/* A failed "Launch again" (prepare error) sets tileErrors but the
              launcher isn't mounted to show it — surface the current session's
              launcher error here. launch() clears tileErrors at the start of
              the next attempt, so a failed relaunch's message stays up until
              then. */}
          {agent.session.command && tileErrors[agent.session.command] && (
            <div className="agent-session-error">Agent setup failed: {tileErrors[agent.session.command]}</div>
          )}
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
