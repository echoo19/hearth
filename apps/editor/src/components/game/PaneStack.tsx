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
import React, { useRef } from 'react';
import { useApp, type PaneTab } from '../../store';
import { GamePane } from './GamePane';
import { ConsolePanel } from '../ConsolePanel';
import { TesterStage } from '../tester/TesterStage';
import { nextTabIndex, tabIds } from '../ui/tabKeys';

const TABS: { id: PaneTab; label: string }[] = [
  { id: 'game', label: 'Game' },
  { id: 'tester', label: 'Tester' },
  { id: 'console', label: 'Console' },
];

export function PaneStack() {
  const paneTab = useApp((s) => s.paneTab);
  const setPaneTab = useApp((s) => s.setPaneTab);
  const consoleUnread = useApp((s) => s.consoleUnread);
  const testerRunning = useApp((s) => s.tester.running || s.tester.starting);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

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
      {/* Real tabpanels, each naming the tab that opens it. The strip claimed
          `role="tablist"` while these were plain divs, so a screen reader was
          told about tabs that controlled nothing. `tabIndex={0}` because a
          panel with no focusable content of its own (the game is an iframe,
          the console is a log) is otherwise unreachable by keyboard: there
          would be nothing to press Page Down against. */}
      <div className="pane-surface">
        {TABS.map((tab) => {
          const ids = tabIds('pane', tab.id);
          return (
            <div
              key={tab.id}
              id={ids.panel}
              className="pane-view"
              role="tabpanel"
              aria-labelledby={ids.tab}
              tabIndex={0}
              hidden={paneTab !== tab.id}
            >
              {tab.id === 'game' ? <GamePane /> : tab.id === 'tester' ? <TesterStage /> : <ConsolePanel />}
            </div>
          );
        })}
      </div>

      <div className="pane-tabs" role="tablist" aria-label="Playtest column">
        {TABS.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabIds('pane', tab.id).tab}
            aria-controls={tabIds('pane', tab.id).panel}
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            className="pane-tab"
            aria-selected={paneTab === tab.id}
            // Roving tabindex: the strip is ONE stop in the tab order and the
            // arrows move within it. Three separate stops was the old
            // behaviour, and it made getting past the column cost three
            // presses while the arrows did nothing at all.
            tabIndex={paneTab === tab.id ? 0 : -1}
            onKeyDown={(e) => {
              const next = nextTabIndex(e.key, index, TABS.length);
              if (next === null) return;
              e.preventDefault();
              // Selection follows focus, the tablist default. Every tab is a
              // view of the same column, and all three stay mounted, so
              // arrowing through them costs nothing.
              setPaneTab(TABS[next].id);
              tabRefs.current[next]?.focus();
            }}
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
        {/* No close control here. The column is toggled from the top bar,
            where it is opened, and one control that both opens and closes is
            easier to find again than a separate way out buried at the far end
            of a tab strip. */}
      </div>
    </section>
  );
}
