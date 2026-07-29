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
import { OPEN_FOLDER_EVENT } from '../components/shell/useOpenFolder';
import { ProjectMark } from './ProjectMark';

/** How many projects the menu offers before it stops. */
const MAX_LISTED = 8;

/**
 * The folder's own name, for a path this control cannot otherwise name.
 *
 * A last resort, and an honest one: it is what the folder is called on disk.
 * The alternative was showing the empty label beside an armed button, which
 * says nothing is chosen while something is.
 */
export function folderLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
}

/**
 * What the trigger is allowed to say, given what this control knows.
 *
 * Pure, because the bug it fixes was a disagreement between two surfaces and
 * the rule that settles it should be checkable without either. This control
 * names the current project from its OWN fetch of recent workspaces, which
 * answers an empty list when the request fails and is capped besides. Callers
 * choose the target from somewhere else entirely, so whenever the two
 * disagreed the trigger read "Pick a game" while the Play button beside it was
 * armed and aimed at a real folder. A value is never rendered as no value.
 */
export function selectorLabel(
  target: string | null | undefined,
  known: string | null,
  valueLabel: string | null | undefined,
  emptyLabel: string,
): string {
  if (known) return known;
  if (!target) return emptyLabel;
  return valueLabel ?? folderLabel(target);
}

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
  /**
   * What to call the current value when this control's own list does not have
   * it. The caller often knows the name from somewhere this does not read.
   */
  valueLabel,
}: {
  value?: string | null;
  onChange?: (path: string | null) => void;
  allowNew?: boolean;
  emptyLabel?: string;
  valueLabel?: string | null;
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

  const unlisted = Math.max(0, projects.length - listed.length);

  const items: MenuItem[] = [
    ...listed.map(
      (row): MenuItem => ({
        label: row.name,
        onSelect: () => setTarget(row.path),
      }),
    ),
    // Said rather than silently cut. The Tester screen's history spans more
    // projects than this menu offers, so a game whose sessions are on that list
    // can be one this menu will not let you pick, and a menu that just stops is
    // a menu that reads as "these are all your projects".
    ...(unlisted > 0
      ? [
          { separator: true } as MenuItem,
          {
            header: unlisted === 1 ? '1 older project not listed' : `${unlisted} older projects not listed`,
          } as MenuItem,
        ]
      : []),
    ...(allowNew
      ? [
          ...(listed.length > 0 ? [{ separator: true } as MenuItem] : []),
          { label: 'New project', icon: 'plus', onSelect: () => setTarget(null) } as MenuItem,
        ]
      : []),
  ];

  // Nothing to pick and no "New project" to offer: on the Tester screen, on a
  // first run, this opened a blank panel. A control that does nothing, with
  // nothing saying why. Say what is going on, and offer the one act that makes
  // it stop being true — the rail owns the folder picker and answers this
  // event for the whole window.
  if (items.length === 0) {
    items.push(
      { header: 'No projects yet' },
      {
        label: 'Open a project…',
        icon: 'folder',
        onSelect: () => window.dispatchEvent(new CustomEvent(OPEN_FOLDER_EVENT)),
      },
    );
  }

  const label = selectorLabel(target, current?.name ?? null, valueLabel, emptyLabel);

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
