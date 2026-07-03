import React from 'react';
import { PERMISSION_DOCS, PERMISSION_MODES } from '@hearth/core';
import { useEditor } from '../store';
import { CodeBlock } from './ui';

export function AgentPanel() {
  const projectPath = useEditor((s) => s.projectPath) ?? '<project path>';
  const meta = useEditor((s) => s.meta);
  const repoRoot = meta?.repoRoot ?? '<hearth repo root>';
  // In the packaged desktop app these are self-contained single-file bundles
  // shipped with the app; from a repo checkout they're the built packages.
  const cliPath = meta?.toolPaths?.cli ?? `${repoRoot}/packages/cli/dist/main.js`;
  const mcpPath = meta?.toolPaths?.mcp ?? `${repoRoot}/packages/mcp-server/dist/main.js`;

  const cliBlock = [
    `alias hearth="node ${cliPath}"`,
    `cd ${projectPath}`,
    `hearth inspect project --json      # learn the project`,
    `hearth snapshot                    # checkpoint before changes`,
    `hearth inspect scene <scene> --json`,
    `hearth validate --json             # after changes`,
    `hearth diff                        # review what changed`,
  ].join('\n');

  const mcpClaudeBlock = `claude mcp add hearth -- node ${mcpPath} --project ${projectPath}`;

  const mcpJsonBlock = JSON.stringify(
    {
      mcpServers: {
        hearth: {
          command: 'node',
          args: [mcpPath, '--project', projectPath],
        },
      },
    },
    null,
    2,
  );

  return (
    <div className="panel-body agent-panel">
      <p>
        Hearth is agent-native: everything this editor does goes through the same command system that the{' '}
        <code>hearth</code> CLI and the MCP server expose. Point a coding agent at this project and review its
        work in the Diff panel. New projects also get AGENTS.md / CLAUDE.md with these instructions baked in.
      </p>

      <h4>CLI (any agent with a shell)</h4>
      <CodeBlock code={cliBlock} />

      <h4>MCP: Claude Code</h4>
      <CodeBlock code={mcpClaudeBlock} />

      <h4>MCP: generic .mcp.json</h4>
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
          <strong>Snapshot</strong> before changing anything, so the human can diff and revert.
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
          <strong>Diff</strong> at the end and summarize what changed.
        </li>
      </ol>
    </div>
  );
}
