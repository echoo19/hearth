/**
 * Which project an act lands in.
 *
 * It sits ON the thing it aims — beside the composer's + and model picker, or
 * beside the Tester screen's Play — because it is the same kind of fact as
 * those: something the act carries, chosen before you press the button. Not a
 * separate screen, not a step. Hearth's whole opening move is "say what you
 * want", and asking someone to pick a location first would put a filing
 * decision in front of a creative one.
 *
 * It defaults to whatever you touched last, so the common case needs no
 * interaction at all. "New project" is the last item rather than the first,
 * for the same reason.
 *
 * Two callers, one control, on purpose. The composer aims a message; the
 * Tester screen aims a playtest. Aiming a global act at a project is ONE idea
 * in this app and it should look like one idea, which is why this takes a
 * value and an onChange rather than reaching into the store for the composer's.
 */
import React, { useEffect, useState } from 'react';
import { useApp } from '../store';
import { apiRecentWorkspaces } from '../api';
import type { RecentWorkspace } from '../types';
import { Icon } from '../components/ui';
import { MenuButton, type MenuItem } from '../components/ui/Menu';
import { ProjectMark } from './ProjectMark';

/** How many projects the menu offers before it stops. */
const MAX_LISTED = 8;

export function ProjectSelector({
  value,
  onChange,
  /**
   * Whether "New project" is offered. The composer offers it: a message with
   * nowhere to land is how most projects get made. Aiming a playtest does not,
   * because there is nothing to play in a folder that does not exist yet.
   */
  allowNew = true,
  /** What the trigger says when nothing is picked, for a screen with no "new". */
  emptyLabel = 'New project',
}: {
  value?: string | null;
  onChange?: (path: string | null) => void;
  allowNew?: boolean;
  emptyLabel?: string;
} = {}) {
  const composeTarget = useApp((s) => s.composeTarget);
  const setComposeTarget = useApp((s) => s.setComposeTarget);
  const projectPath = useApp((s) => s.projectPath);
  const [projects, setProjects] = useState<RecentWorkspace[]>([]);

  // No caller given: this is the composer's, which is what it always was.
  const target = value !== undefined ? value : composeTarget;
  const setTarget = onChange ?? setComposeTarget;

  useEffect(() => {
    void apiRecentWorkspaces().then((rows) => setProjects(rows.filter((row) => row.exists)));
  }, [projectPath]);

  const current = projects.find((row) => row.path === target) ?? null;
  const listed = projects.slice(0, MAX_LISTED);

  const items: MenuItem[] = [
    ...listed.map(
      (row): MenuItem => ({
        label: row.name,
        onSelect: () => setTarget(row.path),
      }),
    ),
    ...(allowNew
      ? [
          ...(listed.length > 0 ? [{ separator: true } as MenuItem] : []),
          { label: 'New project', icon: 'plus', onSelect: () => setTarget(null) } as MenuItem,
        ]
      : []),
  ];

  const label = current ? current.name : emptyLabel;

  return (
    <MenuButton
      label={`Project: ${label}`}
      align="left"
      triggerClassName="project-select"
      items={items}
      trigger={
        <>
          {current ? (
            <ProjectMark path={current.path} identity={current.identity} size={12} />
          ) : (
            <span className="project-select-new" aria-hidden="true">
              <Icon name={allowNew ? 'plus' : 'folder'} size={11} />
            </span>
          )}
          <span className="project-select-name">{label}</span>
          <Icon name="chevron" size={10} />
        </>
      }
    />
  );
}
