/**
 * First-run launch surface: "Launch your agent" + one tile per agent CLI.
 * Presentational — AgentPanel owns the store wiring, detection, prepare and
 * pty calls, and passes state down. Pure helpers exported for unit tests.
 */
import React, { type ReactElement } from 'react';
import type { DetectAgentsResult } from '../../../server/agentSetup';
import { Icon } from '../ui';
import { Button } from '../ui/Button';
import { Tooltip } from '../ui/Tooltip';

/**
 * Wraps a disabled control in a Tooltip + focusable span, matching
 * Inspector.tsx's `AutotileRuleFields` "disabledReason" pattern — a disabled
 * native control (`<select disabled>`, `<button disabled>`) doesn't
 * reliably surface hover/focus for its own Tooltip, so the wrapper carries
 * it instead. Renders `children` bare when there's no reason (the caller is
 * expected to give the control its OWN Tooltip for the enabled case, since
 * this helper has nothing useful to show then).
 *
 * Moved here (was AgentPanel.tsx-local) so the ready-tile launch button and
 * the plain-terminal row can share it: both wrap a natively `disabled`
 * button, which never surfaces hover/focus for its own Tooltip, so the
 * "why" (e.g. "Open a project first.") would otherwise silently never show.
 * AgentPanel.tsx imports it back from here rather than keeping its own copy.
 */
export function DisabledHint({ reason, children }: { reason: string | null; children: ReactElement }) {
  if (!reason) return children;
  return (
    <Tooltip content={reason}>
      <span tabIndex={0} style={{ display: 'inline-flex' }}>
        {children}
      </span>
    </Tooltip>
  );
}

export type AgentLauncher = 'claude' | 'codex' | 'opencode' | 'hermes' | 'shell';
/** The launchers that wire up a Hearth MCP config (everything except shell). */
export type AgentToolLauncher = Exclude<AgentLauncher, 'shell'>;

export const AGENT_LAUNCHER_LABELS: Record<AgentLauncher, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  hermes: 'Hermes',
  shell: 'Terminal / other CLI',
};

/** Where each tool's Hearth MCP config is written, for the setup hint. */
const AGENT_LAUNCHER_CONFIG: Record<AgentToolLauncher, string> = {
  claude: '.mcp.json',
  codex: '~/.codex/config.toml',
  opencode: 'opencode.json',
  hermes: '~/.hermes/config.yaml',
};

/**
 * One honest, one-line setup hint per launcher. Codex/Hermes read a single
 * GLOBAL config, so we say Hearth points it at THIS project on launch; OpenCode
 * additionally surfaces whether local Ollama models were found. Pure (no store
 * access) so it's unit-testable.
 */
export function describeLauncher(launcher: AgentLauncher, ollamaModels: string[]): string {
  switch (launcher) {
    case 'claude':
      return 'Claude Code connects automatically. Hearth writes the MCP config to .mcp.json in this project.';
    case 'codex':
      return 'Codex reads a global config (~/.codex/config.toml); Hearth points it at this project on launch.';
    case 'opencode':
      return ollamaModels.length > 0
        ? `OpenCode connects via opencode.json, with an Ollama provider for your ${ollamaModels.length} local model${ollamaModels.length === 1 ? '' : 's'}.`
        : 'OpenCode connects via opencode.json. Install Ollama and pull a model to run fully local.';
    case 'hermes':
      return 'Hermes reads a global config (~/.hermes/config.yaml); Hearth points it at this project on launch.';
    case 'shell':
      return 'Plain terminal for any other shell-native agent. The hearth CLI is already on PATH.';
    default: {
      const never: never = launcher;
      return String(never);
    }
  }
}

export const INSTALL_COMMANDS: Record<AgentToolLauncher, string | null> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  opencode: 'npm install -g opencode-ai',
  // No single blessed installer; the tile links out to the connect guide
  // instead of an Install button — see CONNECT_HERMES_URL below.
  hermes: null,
};

/**
 * Where the Hermes tile's "Setup guide" link points — same docs-site
 * convention as ExportDialog's SHIPPING_GUIDE_URL (exportJob.ts), rendered
 * from docs/connect-hermes.md in this repo.
 */
export const CONNECT_HERMES_URL = 'https://hearthengine.com/docs/connect-hermes';

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
  const terminalButton = (
    <button
      type="button"
      className="agent-terminal-row"
      disabled={disabledReason !== null || busy}
      onClick={() => onLaunch('shell')}
    >
      Open a plain terminal
    </button>
  );
  return (
    <div className="agent-launcher">
      <div className="agent-launcher-hero">
        <h3>Launch your agent</h3>
        <p className="agent-launcher-sub">
          One click. Hearth connects it to this project automatically.
        </p>
      </div>

      {detectFailed ? (
        <div className="agent-detect-failed">
          <span>Couldn't check which agents are installed.</span>
          <Button size="sm" onClick={onRetryDetect}>Retry</Button>
        </div>
      ) : (
        <div className="agent-tiles">
          {tiles.map((tile) => {
            const launchButton = (
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
            );
            return (
              <div key={tile.id} className={`agent-tile agent-tile-${tile.status}`}>
                {tile.status === 'ready' ? (
                  disabledReason !== null ? (
                    <DisabledHint reason={disabledReason}>{launchButton}</DisabledHint>
                  ) : (
                    <Tooltip content={tile.hint}>{launchButton}</Tooltip>
                  )
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
                        // No blessed installer for this launcher (Hermes) —
                        // point at the connect guide instead of a dead-end
                        // "Not installed" label.
                        <a
                          className="agent-tile-state agent-tile-link"
                          href={CONNECT_HERMES_URL}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Setup guide
                        </a>
                      )}
                    </div>
                  </Tooltip>
                )}
                {errors[tile.id] && <div className="agent-tile-error">{errors[tile.id]}</div>}
              </div>
            );
          })}
        </div>
      )}

      {disabledReason !== null ? (
        <DisabledHint reason={disabledReason}>{terminalButton}</DisabledHint>
      ) : (
        <Tooltip content={describeLauncher('shell', [])}>{terminalButton}</Tooltip>
      )}
      {errors.shell && <div className="agent-tile-error">{errors.shell}</div>}

      <div className="agent-launcher-foot">
        <span className="agent-launcher-mode">{modeLabel}</span>
        {gear}
      </div>
    </div>
  );
}
