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

/**
 * Client-side mirror of agentSetup.ts's MODE_ARGS (a type-only import keeps
 * that server module out of the bundle): the `--mode` tokens each picker tier
 * expands to. Used by the manual-setup blocks (L-092) so a copied command
 * grants exactly what the picker shows.
 */
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

  // L-092 (AGENT-4): the manual blocks carry the SAME --mode the picker
  // selects — copying the command instead of clicking Start must not silently
  // downgrade the chosen tier to the server default.
  const mcpClaudeBlock = `claude mcp add hearth -- node ${mcpPath} --project ${manualProjectPath} --mode ${AGENT_MODE_ARGS[agentMode]}`;

  const mcpJsonBlock = JSON.stringify(
    {
      mcpServers: {
        hearth: {
          command: 'node',
          args: [mcpPath, '--project', manualProjectPath, '--mode', AGENT_MODE_ARGS[agentMode]],
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="agent-manual-setup">
      <div className="agent-manual-body agent-panel">
        <p>
          Hearth is agent-native: everything this editor does goes through the same command system that the{' '}
          <code>hearth</code> CLI and the MCP server expose. Pick a launcher above (Claude Code, Codex, OpenCode
          with local Ollama models, or Hermes) and hit Start. Hearth writes the MCP config into that tool's own
          format, and the <code>hearth</code> CLI is already on the terminal's PATH. Or open the plain terminal for
          any other shell-native agent. New projects also get AGENTS.md and CLAUDE.md with these instructions baked in.
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
          <code>--mode</code>). The blocks above carry the mode selected in the toolbar picker; narrow an
          agent's grant to what its task needs.
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
    </div>
  );
}
