/**
 * The right-hand stack: the game, with where raw output goes (Console) beside
 * it.
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
import { TesterStage } from '../tester/TesterStage';
import { IconButton } from '../ui/Button';

const TABS: { id: PaneTab; label: string }[] = [
  { id: 'game', label: 'Game' },
  { id: 'tester', label: 'Tester' },
  { id: 'console', label: 'Console' },
];

export function PaneStack() {
  const paneTab = useApp((s) => s.paneTab);
  const setPaneTab = useApp((s) => s.setPaneTab);
  const setPaneOpen = useApp((s) => s.setPaneOpen);
  const consoleUnread = useApp((s) => s.consoleUnread);
  const testerRunning = useApp((s) => s.tester.running || s.tester.starting);

  return (
    <section className="pane-stack" aria-label="Game">
      {/* All three stay MOUNTED, and the two you are not looking at are hidden.
          Rendering only the active tab unmounted the other two, which cost more
          than a scroll position: leaving Game tore down the iframe, so coming
          back RESTARTED the person's game from its first frame, and leaving
          Tester threw away the session's picture and everything it had said.
          A tab strip is a way of looking at three things, not a way of ending
          two of them.

          `hidden` rather than a class, because it is the one way of hiding
          that the accessibility tree honours as well as the paint: a tab you
          are not on should not be readable by a screen reader either. */}
      <div className="pane-surface">
        <div className="pane-view" hidden={paneTab !== 'game'}>
          <GamePane />
        </div>
        <div className="pane-view" hidden={paneTab !== 'tester'}>
          <TesterStage />
        </div>
        <div className="pane-view" hidden={paneTab !== 'console'}>
          <ConsolePanel />
        </div>
      </div>

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
            {/* A session runs for minutes, and the person who started it is
                free to go and look at something else. The tab says it is still
                going without pulling them back to it. */}
            {tab.id === 'tester' && testerRunning && (
              <span className="pane-tab-dot" aria-label="playing" />
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
