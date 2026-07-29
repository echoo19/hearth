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
  /**
   * Shown, and not selectable. For a mode that genuinely cannot be entered
   * from here — not for one that is merely unusual.
   *
   * Shown rather than dropped, because a switch that loses an option has told
   * the reader nothing: the two modes are the subject of the control, and one
   * of them quietly vanishing reads as a bug. Disabled with a reason says
   * which mode this is, that the other exists, and what would make it
   * reachable, which is the whole of what the reader needs.
   */
  disabled?: boolean;
  /**
   * Why, in a sentence. Becomes the option's accessible name.
   *
   * NOT a `title` tooltip: the app refuses those outright (styleGates Gate D),
   * because a native tooltip is invisible on touch, invisible to the keyboard,
   * and appears too late to be part of a decision. The sighted reader gets
   * this sentence from whatever the switch's owner puts beside it — the model
   * picker prints it under the switch — and this attribute is what carries it
   * to a screen reader.
   */
  disabledReason?: string;
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
    let next = nextTabIndex(e.key, index, options.length);
    if (next === null) return;
    e.preventDefault();
    // Step over anything disabled, in the direction being travelled, and give
    // up rather than loop if every other option is. Selection follows focus
    // here, so landing on a disabled option would mean selecting it.
    for (let steps = 0; steps < options.length && options[next].disabled === true; steps += 1) {
      const onward = nextTabIndex(e.key, next, options.length);
      if (onward === null || onward === index) return;
      next = onward;
    }
    if (options[next].disabled === true) return;
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
          // The reason wins where there is one: a tab that cannot be pressed
          // has to say why in its own name, because a screen reader user gets
          // no hover and no tooltip.
          aria-label={option.disabledReason ?? option.ariaLabel}
          // `aria-disabled` rather than the attribute: a disabled button is
          // removed from the accessibility tree in some readers, and an option
          // nobody can perceive is the same as one that was dropped. The click
          // and key handlers below do the actual refusing.
          aria-disabled={option.disabled === true || undefined}
          data-disabled={option.disabled === true ? 'true' : undefined}
          // Roving tabindex: the group is one stop, and the arrows move inside
          // it. Tabbing through a switch option by option is the failure this
          // avoids on a control whose whole point is that it is one control.
          tabIndex={option.id === value ? 0 : -1}
          onKeyDown={(e) => onKeyDown(e, i)}
          onClick={() => {
            if (option.disabled === true) return;
            onChange(option.id);
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
