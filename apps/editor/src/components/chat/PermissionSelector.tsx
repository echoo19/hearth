/**
 * How much the agent asks before it acts, for this project.
 *
 * Its own pill beside the model pill, not a section inside it: "who answers"
 * and "what is it allowed to do without asking" are two questions, and the
 * second is the one someone changes on the way into a risky hour and back out
 * of it afterwards. A control you reach for that often does not live two menus
 * deep.
 *
 * Three answers, on one axis (when does it stop and ask):
 *
 *   Ask before writing    every command and every file change waits for you.
 *   or running
 *   Work in this folder   the default, and today's behaviour: work inside the
 *                         project goes ahead, anything outside asks.
 *   Skip all checks       nothing asks, anywhere.
 *
 * The strictest row says "writing or running" rather than "everything", and
 * says so in the row itself rather than in a footnote, because it is not
 * everything: an approval in this app is a command or a file change
 * (ApprovalKind), and a read or a search has no kind it could be raised as.
 * A row promising to ask every time would be believed, and then broken in
 * front of the person who chose it precisely because they wanted to watch. The
 * note carries the other half of the truth: reading is not interrupted.
 *
 * The pill's resting word is what the mode DOES, in the space a pill has. Two
 * of them open with "Ask", which makes the subject of the control readable in
 * a row of pills without opening anything. The third does not, and that is the
 * point: the one mode that never asks is also the one that breaks the pattern.
 *
 * Skip asks for a confirmation the first time a project chooses it, and never
 * again in that project. The acknowledgement is stored per project alongside
 * the mode, so the warning is a conversation you have once rather than a toll
 * on every turn (see store.setPermissionMode).
 *
 * The whole control is absent with no folder open. The setting belongs to a
 * project, so with no project there is nothing for it to be about, and a pill
 * that stores nothing is worse than no pill.
 */
import React, { useState } from 'react';
import { useApp } from '../../store';
import type { PermissionMode } from '../../types';
import { ConfirmDialog, Icon } from '../ui';
import { MenuButton, type MenuItem } from '../ui/Menu';

export interface PermissionChoice {
  mode: PermissionMode;
  /** The pill's resting word: what is happening right now. */
  pill: string;
  /** The menu row: the rule, as an instruction you could have given. */
  label: string;
  /** The row's trailing note: what that rule costs or allows. */
  note: string;
}

/**
 * The three, in the order they loosen. Menu order is deliberate rather than
 * alphabetical: reading down the list is reading one dial being turned up, so
 * where you are on it is legible from position alone.
 */
export const PERMISSION_CHOICES: readonly PermissionChoice[] = [
  { mode: 'ask', pill: 'Ask first', label: 'Ask before writing or running', note: 'Reading is not interrupted' },
  { mode: 'auto', pill: 'Ask outside', label: 'Work in this folder', note: 'Asks about anything outside' },
  { mode: 'skip', pill: 'No checks', label: 'Skip all checks', note: 'Anywhere on this machine' },
];

/** The row for a mode. Never undefined for a mode the window knows. */
export function permissionChoice(mode: PermissionMode): PermissionChoice {
  return PERMISSION_CHOICES.find((choice) => choice.mode === mode) ?? PERMISSION_CHOICES[1];
}

/**
 * Whether choosing `skip` here has to stop and explain itself first. Pure, so
 * the one rule that decides whether a confirmation appears is testable without
 * a render: any mode but skip goes straight through, and skip goes through
 * once the project has been told what it means.
 */
export function needsSkipConfirm(mode: PermissionMode, acknowledged: boolean): boolean {
  return mode === 'skip' && !acknowledged;
}

export function PermissionSelector() {
  const project = useApp((s) => s.projectPath);
  const mode = useApp((s) => s.permissionMode);
  const acknowledged = useApp((s) => s.permissionSkipAcknowledged);
  const setPermissionMode = useApp((s) => s.setPermissionMode);
  const [confirming, setConfirming] = useState(false);

  if (!project) return null;

  const current = permissionChoice(mode);

  const items: MenuItem[] = [
    ...PERMISSION_CHOICES.map<MenuItem>((choice) => ({
      label: choice.label,
      shortcut: choice.note,
      checked: choice.mode === mode,
      onSelect: () => {
        if (needsSkipConfirm(choice.mode, acknowledged)) setConfirming(true);
        else void setPermissionMode(choice.mode);
      },
    })),
  ];

  return (
    <>
      <MenuButton
        label="Permissions"
        align="right"
        items={items}
        // `model-pill` for the metrics, so the two pills in this row are the
        // same object at rest; `permission-pill` carries only what differs.
        triggerClassName={`model-pill permission-pill${mode === 'skip' ? ' is-skipping' : ''}`}
        popoverClassName="permission-menu"
        // Two things the rows cannot say for themselves: which conversations
        // this reaches, and which it does not. The tester runs on the middle
        // setting whatever is chosen here (asking an empty room would wedge an
        // unattended session, and skipping would leave it with nothing to work
        // against), and a CLI started in the terminal owns its own permissions
        // from the moment it starts. Stated as a limit rather than explained,
        // because a menu opened mid-sentence is not the place to teach either.
        heading={
          <p className="permission-menu-blurb">
            For chats in this project. The tester and the terminal keep their own limits.
          </p>
        }
        trigger={
          <>
            <span className="permission-pill-name">{current.pill}</span>
            <Icon name="chevron" size={9} />
          </>
        }
      />
      <ConfirmDialog
        open={confirming}
        title="Skip all checks?"
        body={
          'The agent will run commands and change files anywhere on this machine without asking you first. ' +
          'This project stays this way until you change it back, and Hearth will not ask again here.'
        }
        confirmLabel="Skip all checks"
        // Cancel takes the focus (see ConfirmDialog): the reflex Enter on a
        // dialog that appeared mid-click must not be what turns the checks off.
        danger
        onConfirm={() => {
          setConfirming(false);
          // The mode and the acknowledgement in one write. A project on skip
          // that was never recorded as having been told would ask again on the
          // next window, which is the nagging this exists to prevent.
          void setPermissionMode('skip', true);
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
