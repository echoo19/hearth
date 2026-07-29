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
import { FOCUS_SEARCH_EVENT } from '../components/shell/ShortcutLayer';
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

/**
 * What tells two same-named projects apart, keyed by path.
 *
 * Only rows whose visible name collides get an entry: the common case is a
 * list of distinct names, and it must stay a list of plain rows. Two
 * "mini-platformer"s side by side, though, are two identical strings with a
 * button each, and the reader picking between them is picking blind.
 *
 * The hint is the shortest trailing piece of the row's path that the others
 * in the collision do not share, so it is exactly as long as it has to be:
 * usually just the folder, reaching up a segment when the folders collide
 * too. A hint that merely restates the row's own name reaches further as
 * well, because it would have told the reader nothing the name had not.
 *
 * Pure, and shared: the composer's picker and the rail's Projects list are
 * two views of the same list, and a reader who can tell two rows apart in
 * one must be able to tell them apart the same way in the other.
 */
export function whereHints(rows: readonly { path: string; name: string }[]): Map<string, string> {
  const hints = new Map<string, string>();
  const byName = new Map<string, { path: string; name: string }[]>();
  for (const row of rows) {
    const group = byName.get(row.name);
    if (group) group.push(row);
    else byName.set(row.name, [row]);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    // Both separators, same reason as folderLabel: no `path` in a browser,
    // and the app runs on Windows too.
    const segments = group.map((row) => row.path.split(/[\\/]/).filter((part) => part !== ''));
    const depths = group.map(() => 1);
    // Deepen any hint that still clashes with a sibling's, or that merely
    // restates the row's own name, until every row says something its
    // doubles do not. Paths are unique (they are the list's keys), so two
    // full paths can never clash and this settles.
    for (;;) {
      const drafts = group.map((_, i) => segments[i].slice(-depths[i]).join('/'));
      let changed = false;
      drafts.forEach((draft, i) => {
        const clashes = drafts.some((other, j) => j !== i && other === draft);
        const restates = draft === group[i].name;
        if ((clashes || restates) && depths[i] < segments[i].length) {
          depths[i] += 1;
          changed = true;
        }
      });
      if (!changed) {
        group.forEach((row, i) => hints.set(row.path, drafts[i]));
        break;
      }
    }
  }
  return hints;
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

  // Only when two visible rows wear one name. The menu's trailing-note slot
  // (the same one the permission menu uses for its costs) carries where each
  // one lives, because "which mini-platformer" is a question about the disk.
  const hints = whereHints(listed);

  const items: MenuItem[] = [
    ...listed.map(
      (row): MenuItem => ({
        label: row.name,
        shortcut: hints.get(row.path),
        onSelect: () => setTarget(row.path),
      }),
    ),
    // Said rather than silently cut, AND pressable. The Tester screen's
    // history spans more projects than this menu offers, so a game whose
    // sessions are on that list can be one this menu will not let you pick.
    // This row used to be a bare header, which named the problem and offered
    // nothing to do about it: a label with nothing to press is a dead end
    // wearing a menu's clothes. Now it opens the rail's search, the one
    // surface that can reach every project on the machine, and the rail owns
    // that event for the whole window the same way it owns "Open folder…".
    ...(unlisted > 0
      ? [
          { separator: true } as MenuItem,
          {
            label: unlisted === 1 ? 'Search 1 older project…' : `Search ${unlisted} older projects…`,
            icon: 'search',
            onSelect: () => window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT)),
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
