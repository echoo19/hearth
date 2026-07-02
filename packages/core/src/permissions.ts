/**
 * Permission model for agent operations.
 *
 * Modes form an escalating set of capabilities. A session (CLI invocation,
 * MCP server, editor) is granted a set of modes; a command runs only if its
 * required capability is granted. `read-only` is always implied.
 */

export const PERMISSION_MODES = ['read-only', 'safe-edit', 'code-edit', 'asset-edit', 'build'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PERMISSION_DOCS: Record<PermissionMode, string> = {
  'read-only': 'Inspect project, scenes, entities; validate; diff; run non-mutating playtests.',
  'safe-edit': 'Create/modify/delete scenes and entities; add/remove components; set component properties; snapshot.',
  'code-edit': 'Create and edit scripts; attach scripts to entities.',
  'asset-edit': 'Import assets; create procedural assets; modify asset metadata.',
  build: 'Build/export the project.',
};

/** The default grant used by tools unless the user narrows it. */
export const DEFAULT_MODES: PermissionMode[] = ['read-only', 'safe-edit', 'code-edit', 'asset-edit'];

export class PermissionError extends Error {
  constructor(
    public readonly required: PermissionMode,
    public readonly granted: PermissionMode[],
    commandName: string,
  ) {
    super(
      `Command "${commandName}" requires permission mode "${required}" but this session only grants: ${granted.join(', ') || '(none)'}. ` +
        `Re-run with the needed mode enabled (e.g. CLI flag --allow ${required}, or MCP server --mode).`,
    );
    this.name = 'PermissionError';
  }
}

export function hasPermission(granted: PermissionMode[], required: PermissionMode): boolean {
  if (required === 'read-only') return true;
  return granted.includes(required);
}

export function parseModes(input: string): PermissionMode[] {
  const parts = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const modes: PermissionMode[] = ['read-only'];
  for (const part of parts) {
    if (part === 'all') return [...PERMISSION_MODES];
    if ((PERMISSION_MODES as readonly string[]).includes(part)) {
      modes.push(part as PermissionMode);
    } else {
      throw new Error(`Unknown permission mode "${part}". Valid modes: ${PERMISSION_MODES.join(', ')}, all`);
    }
  }
  return [...new Set(modes)];
}
