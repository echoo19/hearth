/**
 * Which project the next message starts in.
 *
 * It sits on the blank composer, next to the + and the model picker, because
 * it is the same kind of fact as those two: something the turn carries, chosen
 * before you press send. Not a separate screen, not a step — Hearth's whole
 * opening move is "say what you want", and asking someone to pick a location
 * first would put a filing decision in front of a creative one.
 *
 * It defaults to whatever you touched last, so the common case (keep working
 * on the same game) needs no interaction at all. "New project" is the last
 * item rather than the first, for the same reason.
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

export function ProjectSelector() {
  const target = useApp((s) => s.composeTarget);
  const setTarget = useApp((s) => s.setComposeTarget);
  const projectPath = useApp((s) => s.projectPath);
  const [projects, setProjects] = useState<RecentWorkspace[]>([]);

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
    ...(listed.length > 0 ? [{ separator: true } as MenuItem] : []),
    {
      label: 'New project',
      icon: 'plus',
      onSelect: () => setTarget(null),
    },
  ];

  return (
    <MenuButton
      label={`Project: ${current ? current.name : 'New project'}`}
      align="left"
      triggerClassName="project-select"
      items={items}
      trigger={
        <>
          {current ? (
            <ProjectMark path={current.path} identity={current.identity} size={12} />
          ) : (
            <span className="project-select-new" aria-hidden="true">
              <Icon name="plus" size={11} />
            </span>
          )}
          <span className="project-select-name">{current ? current.name : 'New project'}</span>
          <Icon name="chevron" size={10} />
        </>
      }
    />
  );
}
