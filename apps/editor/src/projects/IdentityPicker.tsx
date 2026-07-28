/**
 * Choosing what a project looks like.
 *
 * Two rows of swatches, no dialog. Picking a mark for a game is a small,
 * reversible, obviously-visual decision — the kind that should happen in place,
 * next to the thing changing, with the result visible the instant you click.
 * Wrapping that in a modal with a Save button would make it feel like a
 * settings form, which is the opposite of what it is.
 *
 * Every cell is a real button: keyboard reachable, with its own pressed state,
 * because a grid of divs with click handlers is the classic way this control
 * gets built and the classic way it becomes unusable without a mouse.
 */
import React from 'react';
import { Icon } from '../components/ui';
import { PROJECT_COLORS, PROJECT_ICONS, markLabel, resolveIdentity, type ProjectIdentity } from './identity';

export function IdentityPicker({
  path,
  identity,
  onChange,
}: {
  path: string;
  identity?: ProjectIdentity | null;
  /** An empty string clears the field back to the one derived from the path. */
  onChange: (patch: { icon?: string; color?: string }) => void;
}) {
  const current = resolveIdentity(path, identity);

  return (
    <div className="identity-picker">
      <div className="identity-row" role="group" aria-label="Colour">
        {PROJECT_COLORS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="identity-swatch"
            style={{ '--mark': entry.oklch } as React.CSSProperties}
            aria-label={entry.key}
            aria-pressed={current.color === entry.key}
            onClick={() => onChange({ color: entry.key })}
          />
        ))}
      </div>
      <div className="identity-row is-glyphs" role="group" aria-label="Mark">
        {PROJECT_ICONS.map((name) => (
          <button
            key={name}
            type="button"
            className="identity-glyph"
            style={{ '--mark': current.colorValue } as React.CSSProperties}
            aria-label={markLabel(name)}
            aria-pressed={current.icon === name}
            onClick={() => onChange({ icon: name })}
          >
            <Icon name={name} size={13} />
          </button>
        ))}
      </div>
    </div>
  );
}
