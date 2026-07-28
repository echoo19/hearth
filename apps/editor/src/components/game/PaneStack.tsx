/**
 * The right-hand stack: the game, with its supporting surfaces stacked under
 * it — what the probe saw (the evidence rail), and where raw output goes
 * (Console).
 *
 * The shell is deliberately NOT here. A terminal running the user's own CLI
 * agent is a conversation, not a readout, so it lives in the conversation
 * column (components/chat/TerminalPane.tsx) as the other half of that column's
 * mode switch.
 *
 * The game is the default and stays the default. Tabs, not a panel system: two
 * surfaces, one visible, no arranging.
 */
import React from 'react';
import { useApp, type PaneTab } from '../../store';
import { GamePane } from './GamePane';
import { ConsolePanel } from '../ConsolePanel';
import { EvidenceRail } from '../evidence/EvidenceRail';
import { IconButton } from '../ui/Button';

const TABS: { id: PaneTab; label: string }[] = [
  { id: 'game', label: 'Game' },
  { id: 'console', label: 'Console' },
];

export function PaneStack() {
  const paneTab = useApp((s) => s.paneTab);
  const setPaneTab = useApp((s) => s.setPaneTab);
  const setPaneOpen = useApp((s) => s.setPaneOpen);
  const consoleUnread = useApp((s) => s.consoleUnread);

  return (
    <section className="pane-stack" aria-label="Game">
      <div className="pane-surface">
        {paneTab === 'game' && <GamePane />}
        {paneTab === 'console' && <ConsolePanel />}
      </div>

      <EvidenceRail />

      <div className="pane-tabs" role="tablist" aria-label="Playtest column">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            className="pane-tab"
            aria-selected={paneTab === tab.id}
            onClick={() => setPaneTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'console' && consoleUnread > 0 && (
              <span className="pane-tab-badge" aria-label={`${consoleUnread} unread`}>
                {consoleUnread > 99 ? '99+' : consoleUnread}
              </span>
            )}
          </button>
        ))}
        <span className="pane-tabs-gap" />
        {/* The way out. It sits in the pane's own strip rather than floating
            over the game, because a control on top of a running game is a
            control the player can hit by accident. */}
        {/* `cross`, not `close` — the latter is a door-with-an-arrow, which
            means "leave the folder". This dismisses a column. */}
        <IconButton
          icon="cross"
          label="Close playtest"
          iconSize={12}
          className="pane-close"
          onClick={() => setPaneOpen(false)}
        />
      </div>
    </section>
  );
}
