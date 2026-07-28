/**
 * Settings — the window it opens in, and nothing else.
 *
 * Everything that used to be here is a pane now (components/settings/*). This
 * file is down to the two things that genuinely belong to the shell: the
 * window event that opens the panel, and the dialog it opens in.
 *
 * The event is not ceremony. Settings is reached from the rail and from the
 * native menu, both of which live outside this tree, and one window event is
 * cheaper than threading a callback through the whole shell. `close` is its
 * mirror, for a pane that sends you somewhere else in the app and needs the
 * dialog to get out of the way first.
 *
 * `Modal` renders its `title` as the dialog's heading and names the dialog by
 * it. The panel carries its own headings — one per pane — so a second one at
 * the top would be a title above a title; it is kept in the DOM for the
 * accessible name and hidden visually (see settings.css).
 */
import React, { useEffect, useState } from 'react';

// The provider sentences moved to their own file when the dialog became a
// shell. Re-exported from here because that is where the rest of the app
// already imports them from, and a rename is not what this change is about.
//
// Ahead of the SettingsShell import on purpose: the Agents pane imports these
// four from here, and the shell reaches that pane through the registry — so
// this module is genuinely in a cycle with it. Naming providerStatus first
// makes it the module that finishes evaluating first, which is what keeps the
// cycle from depending on hoisting to work.
export {
  anthropicUsable,
  keySourceLabel,
  openAiStatusLabel,
  openAiUsable,
} from '../settings/providerStatus';

import { Modal } from '../ui';
import { SettingsShell } from '../settings/SettingsShell';

/** Ask for the settings panel. Dispatched by the rail and the native menu. */
export const OPEN_SETTINGS_EVENT = 'hearth:open-settings';

/** Dismiss it. Dispatched by a pane whose action takes you elsewhere. */
export const CLOSE_SETTINGS_EVENT = 'hearth:close-settings';

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  // Where to land. Carried on the event because the places that ask for
  // settings are asking for a specific one: "no API key yet" means Agents, and
  // dropping someone on General to go and find it is a worse answer than the
  // old single-question dialog gave. Absent means the first pane.
  const [pane, setPane] = useState<string | undefined>(undefined);

  useEffect(() => {
    const onOpen = (event: Event): void => {
      const asked = (event as CustomEvent<{ pane?: unknown } | null>).detail?.pane;
      setPane(typeof asked === 'string' ? asked : undefined);
      setOpen(true);
    };
    const onClose = (): void => setOpen(false);
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpen);
    window.addEventListener(CLOSE_SETTINGS_EVENT, onClose);
    return () => {
      window.removeEventListener(OPEN_SETTINGS_EVENT, onOpen);
      window.removeEventListener(CLOSE_SETTINGS_EVENT, onClose);
    };
  }, []);

  return (
    <Modal open={open} title="Settings" className="is-settings" onClose={() => setOpen(false)}>
      <SettingsShell initialPane={pane} onClose={() => setOpen(false)} />
    </Modal>
  );
}
