import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useEditor } from '../store';
import { Icon } from './ui';
import { Button } from './ui/Button';
import { Timeline } from './agent/Timeline';
import { dismissAgentGuide, isAgentGuideDismissed } from './agent/guide';
import { useAgentSocket, type AgentStatus } from './agent/useAgentSocket';

const Terminal = lazy(() => import('./agent/Terminal').then((m) => ({ default: m.Terminal })));

export function shouldStartTerminal(
  projectPath: string | null,
  wsStatus: 'disconnected' | 'connecting' | 'connected',
  status: AgentStatus,
): boolean {
  return projectPath !== null && wsStatus === 'connected' && status === 'idle';
}

function statusLabel(status: AgentStatus, exitCode: number | null): string {
  if (status === 'running') return 'Running';
  if (status === 'reconnecting') return 'Reconnecting…';
  if (status === 'exited') return exitCode == null ? 'Stopped' : `Exited (code ${exitCode})`;
  return 'Connecting…';
}

export function AgentPanel() {
  const projectPath = useEditor((s) => s.projectPath);
  const wsStatus = useEditor((s) => s.wsStatus);
  const agent = useAgentSocket();
  const [activityOpen, setActivityOpen] = useState(true);
  const [guideOpen, setGuideOpen] = useState(() =>
    projectPath ? !isAgentGuideDismissed(projectPath) : false,
  );

  useEffect(() => {
    setGuideOpen(projectPath ? !isAgentGuideDismissed(projectPath) : false);
  }, [projectPath]);

  useEffect(() => {
    if (shouldStartTerminal(projectPath, wsStatus, agent.session.status)) agent.start();
  }, [projectPath, wsStatus, agent.session.status, agent.start]);

  function dismissGuide(): void {
    if (projectPath) dismissAgentGuide(projectPath);
    setGuideOpen(false);
  }

  const running = agent.session.status === 'running';

  return (
    <div className="agent-panel-root">
      <div className="panel-toolbar agent-header">
        <span className={`agent-status-dot agent-status-${agent.session.status}`} aria-hidden="true" />
        <span className="agent-header-title">Terminal</span>
        <span className={`agent-status agent-status-${agent.session.status}`}>
          {statusLabel(agent.session.status, agent.session.exitCode)}
        </span>
        <span style={{ flex: 1 }} />
        {agent.session.status === 'exited' && (
          <Button size="sm" onClick={() => agent.start()} disabled={wsStatus !== 'connected'}>
            Restart
          </Button>
        )}
        <Button variant="danger" size="sm" onClick={agent.stop} disabled={!running}>
          Stop
        </Button>
      </div>

      {guideOpen && (
        <div className="agent-guide" role="note">
          <Button variant="ghost" size="sm" className="agent-guide-close" onClick={dismissGuide} aria-label="Dismiss terminal guide">
            ×
          </Button>
          <strong>Run your agent</strong>
          <span>
            This is a regular terminal in your project folder. Type <code>claude</code>,{' '}
            <code>codex</code>, <code>opencode</code>, <code>hermes</code>, or whatever agent you use. The{' '}
            <code>hearth</code> command is ready to use too.
          </span>
        </div>
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
    </div>
  );
}
