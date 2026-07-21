import React from 'react';
import type { WorkspaceTemplate } from '../workspace/layout';

/**
 * Workspace picker for the New-project form: which editor face the project
 * opens with. Purely a client-side layout choice (never sent to the server) —
 * Launcher threads it to createProject, which stages it for the workspace
 * shell's first layout build. Agent is listed first and preselected.
 */
export interface WorkspaceOption {
  id: WorkspaceTemplate;
  label: string;
  description: string;
  glyph: React.ReactNode;
}

const G = { width: 22, height: 22, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** Agent: a terminal prompt. */
function AgentGlyph() {
  return (
    <svg {...G} aria-hidden="true">
      <rect x="3.5" y="4.5" width="15" height="13" rx="2" />
      <path d="M6.5 9l2.5 2-2.5 2M11.5 13.5h4" />
    </svg>
  );
}

/** Studio: a paneled workspace. */
function StudioGlyph() {
  return (
    <svg {...G} aria-hidden="true">
      <rect x="3.5" y="4.5" width="15" height="13" rx="2" />
      <path d="M8.5 4.5v13M8.5 12h10" />
    </svg>
  );
}

export const WORKSPACE_OPTIONS: WorkspaceOption[] = [
  {
    id: 'agent',
    label: 'Agent',
    description: 'Your agent builds, you direct. Terminal, game view, and a console.',
    glyph: <AgentGlyph />,
  },
  {
    id: 'studio',
    label: 'Studio',
    description: 'The full editor, every panel open.',
    glyph: <StudioGlyph />,
  },
];

export function WorkspacePicker({
  value,
  onChange,
  disabled,
}: {
  value: WorkspaceTemplate;
  onChange: (value: WorkspaceTemplate) => void;
  disabled?: boolean;
}) {
  return (
    <div className="tpl-picker" role="radiogroup" aria-label="Workspace">
      {WORKSPACE_OPTIONS.map((opt) => {
        const selected = opt.id === value;
        return (
          <label key={opt.id} className="tpl-card" data-selected={selected}>
            <input
              type="radio"
              name="hearth-workspace"
              value={opt.id}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(opt.id)}
            />
            <span className="tpl-card-glyph" aria-hidden="true">
              {opt.glyph}
            </span>
            <span className="tpl-card-name">{opt.label}</span>
            <span className="tpl-card-desc">{opt.description}</span>
          </label>
        );
      })}
    </div>
  );
}
