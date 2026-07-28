/**
 * The settings panel: a rail of places on the left, one pane on the right.
 *
 * Settings stopped being one question a while ago. A single scrolling column
 * of everything would mean the person who came to paste an API key has to walk
 * past the update check and the standing instructions to get there — so the
 * panel names its places and lets you go straight to one.
 *
 * The rail is a real list of buttons, not tabs: these are destinations, they
 * have headings above them, and a screen reader should be able to say which
 * one you are on (`aria-current`) without the tab pattern's roving-focus
 * rules. Arrow keys still move between them, because a vertical list of five
 * things is a list, and tabbing five times to reach the last one is not how
 * anyone reads one.
 *
 * Search filters the rail rather than the rows inside a pane. Filtering rows
 * would leave you looking at three settings with no idea what they belong to;
 * filtering the rail answers the question people actually have, which is
 * "which page is that on".
 */
import React, { useMemo, useRef, useState } from 'react';
import { Icon } from '../ui';
import { IconButton } from '../ui/Button';
import { SETTINGS_GROUPS, SETTINGS_PANES, filterPanes, type SettingsPane } from './panes';

export function SettingsShell({ initialPane, onClose }: { initialPane?: string; onClose?: () => void }) {
  // A caller can name where to land: "you have no API key" opening on General
  // would be sending someone to the wrong page. An unknown id falls back to
  // the first pane rather than to nothing.
  const [activeId, setActiveId] = useState<string>(
    SETTINGS_PANES.some((pane) => pane.id === initialPane) && initialPane !== undefined
      ? initialPane
      : SETTINGS_PANES[0].id,
  );
  const [query, setQuery] = useState('');
  const railRef = useRef<HTMLElement>(null);

  const matches = useMemo(() => filterPanes(SETTINGS_PANES, query), [query]);
  // The pane on screen is NOT narrowed by the search. Typing something that
  // does not match where you already are should hide a row in the rail, never
  // replace the thing you were reading mid-sentence.
  const active: SettingsPane = SETTINGS_PANES.find((pane) => pane.id === activeId) ?? SETTINGS_PANES[0];

  /** Up/down through whatever the rail is currently showing. */
  function onRailKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...(railRef.current?.querySelectorAll<HTMLButtonElement>('.set-rail-item') ?? [])];
    const here = items.indexOf(document.activeElement as HTMLButtonElement);
    if (here === -1) return;
    event.preventDefault();
    const next = items[here + (event.key === 'ArrowDown' ? 1 : -1)];
    next?.focus();
  }

  return (
    <div className="settings-panel">
      <nav className="set-rail" aria-label="Settings sections" ref={railRef} onKeyDown={onRailKeyDown}>
        <input
          className="input set-rail-search"
          type="search"
          value={query}
          placeholder="Search settings"
          aria-label="Search settings"
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
        />

        {matches.length === 0 ? (
          // Saying so beats an empty rail, which looks like the panel failed to
          // load rather than like a search that found nothing.
          <p className="set-rail-empty" role="status">
            Nothing here matches “{query.trim()}”.
          </p>
        ) : (
          SETTINGS_GROUPS.map((group) => {
            const panes = matches.filter((pane) => pane.group === group.id);
            if (panes.length === 0) return null;
            return (
              <React.Fragment key={group.id}>
                <h2 className="set-rail-title" id={`set-rail-${group.id}`}>
                  {group.title}
                </h2>
                <ul className="set-rail-group" aria-labelledby={`set-rail-${group.id}`}>
                  {panes.map((pane) => (
                    <li key={pane.id}>
                      <button
                        type="button"
                        className="set-rail-item"
                        aria-current={pane.id === active.id}
                        onClick={() => setActiveId(pane.id)}
                      >
                        <Icon name={pane.icon} />
                        {pane.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </React.Fragment>
            );
          })
        )}
      </nav>

      {/* Keyed on the pane so switching remounts it: a pane holds drafts of
          things not yet saved, and carrying one page's half-typed field into
          the next page's identically-shaped field would be a real bug. */}
      <div className="set-pane" role="region" aria-label={active.label} key={active.id}>
        {/* The way out. Escape closes this too, but a panel with no visible
            exit is a panel people feel stuck in — and this one has no footer
            to put a Done button in, because every pane commits its own
            changes as they are made. */}
        {onClose && (
          <IconButton icon="cross" label="Close settings" iconSize={13} className="set-close" onClick={onClose} />
        )}
        <active.Component />
      </div>
    </div>
  );
}
