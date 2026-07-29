/**
 * Switch — the app's segmented two-or-three-way control.
 *
 * For a choice between whole modes, where every option should be readable at
 * once and the current one is part of the answer: Conversation or Game in the
 * narrow top bar, Chat or Terminal at the head of the model picker. Not for
 * commands, and not for a choice with more than about three answers, which is
 * a menu.
 *
 * `role="tablist"` with no tabpanel of its own. Each of these switches decides
 * what a whole region shows, and that region already names itself; a wrapper
 * whose only job is to hold an `aria-controls` would be markup written for the
 * attribute rather than for the reader. Left/Right move between options the
 * way a tablist is expected to, wrapping at both ends.
 */
import React, { useRef, type ReactNode } from 'react';
import { nextTabIndex } from './tabKeys';

export interface SwitchOption<T extends string> {
  id: T;
  label: ReactNode;
  /** Accessible name, when `label` is a glyph or otherwise not a phrase. */
  ariaLabel?: string;
}

export interface SwitchProps<T extends string> {
  /** Names the group — what the choice is about, not what is chosen. */
  label: string;
  options: readonly SwitchOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}

export function Switch<T extends string>({ label, options, value, onChange, className }: SwitchProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number): void {
    // Shared with the playtest column's strip (ui/tabKeys.ts). Both claim
    // `role="tablist"`, which is a promise about behaviour, and writing that
    // promise out twice is how one of them ended up not keeping it.
    const next = nextTabIndex(e.key, index, options.length);
    if (next === null) return;
    e.preventDefault();
    // Selection follows focus, which is the tablist default and the right one
    // here: every option is a view of the same thing, so arrowing through them
    // costs nothing and stopping to press Enter would only be ceremony.
    onChange(options[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div className={className ? `switch ${className}` : 'switch'} role="tablist" aria-label={label}>
      {options.map((option, i) => (
        <button
          key={option.id}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          className="switch-tab"
          aria-selected={option.id === value}
          aria-label={option.ariaLabel}
          // Roving tabindex: the group is one stop, and the arrows move inside
          // it. Tabbing through a switch option by option is the failure this
          // avoids on a control whose whole point is that it is one control.
          tabIndex={option.id === value ? 0 : -1}
          onKeyDown={(e) => onKeyDown(e, i)}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
