import React from 'react';

/**
 * Template picker for the New-project form: a radio group of selectable tiles —
 * Blank (preselected) plus the three genre starters. The external `value` is
 * the server's template contract: `''` means Blank (a plain `createProject`),
 * and `'platformer' | 'topdown' | 'arcade'` scaffold from that template.
 *
 * Semantics: native `<input type="radio">`s (visually hidden but focusable) give
 * real radio-group keyboard navigation and screen-reader behavior for free; the
 * tiles are their labels. Descriptions here are one-line UI copy — the server
 * validates the chosen name against `@hearth/templates`' listTemplates().
 */

export interface TemplateOption {
  /** Radio value in the DOM. `'blank'` maps to the external empty-string value. */
  id: string;
  label: string;
  description: string;
  glyph: React.ReactNode;
}

const G = { width: 22, height: 22, viewBox: '0 0 22 22', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

/** Blank: an empty document with a plus. */
function BlankGlyph() {
  return (
    <svg {...G} aria-hidden="true">
      <rect x="4.5" y="3.5" width="13" height="15" rx="2" />
      <path d="M11 8.5v5M8.5 11h5" />
    </svg>
  );
}

/** Platformer: two platforms and a player standing on one. */
function PlatformerGlyph() {
  return (
    <svg {...G} aria-hidden="true">
      <path d="M3.5 15.5h6M12.5 10.5h6" />
      <rect x="5" y="11.5" width="3.5" height="4" rx="0.6" />
    </svg>
  );
}

/** Top-down: a room seen from above with a centered crosshair. */
function TopdownGlyph() {
  return (
    <svg {...G} aria-hidden="true">
      <rect x="3.8" y="3.8" width="14.4" height="14.4" rx="2" />
      <path d="M11 8.2v5.6M8.2 11h5.6" />
    </svg>
  );
}

/** Arcade: a ship pointing up with a bullet above it. */
function ArcadeGlyph() {
  return (
    <svg {...G} aria-hidden="true">
      <path d="M11 9.5l4.5 8h-9z" />
      <path d="M11 5.2v1.6" />
    </svg>
  );
}

/** The picker options, Blank first. `id: 'blank'` is the empty-string value. */
export const TEMPLATE_OPTIONS: TemplateOption[] = [
  { id: 'blank', label: 'Blank', description: 'Camera, ground, player.', glyph: <BlankGlyph /> },
  {
    id: 'platformer',
    label: 'Platformer',
    description: 'Jump + autotiled ground.',
    glyph: <PlatformerGlyph />,
  },
  {
    id: 'topdown',
    label: 'Top-down',
    description: 'Four-way walking, camera follow.',
    glyph: <TopdownGlyph />,
  },
  { id: 'arcade', label: 'Arcade', description: 'Ship, bullets, a target.', glyph: <ArcadeGlyph /> },
];

const idToValue = (id: string) => (id === 'blank' ? '' : id);
const valueToId = (value: string) => (value === '' ? 'blank' : value);

export interface TemplatePickerProps {
  /** `''` = Blank; otherwise a genre template name. */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function TemplatePicker({ value, onChange, disabled }: TemplatePickerProps) {
  const selectedId = valueToId(value);
  return (
    <div className="tpl-picker" role="radiogroup" aria-label="Project template">
      {TEMPLATE_OPTIONS.map((opt) => {
        const selected = opt.id === selectedId;
        return (
          <label key={opt.id} className="tpl-card" data-selected={selected}>
            <input
              type="radio"
              name="hearth-template"
              value={opt.id}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(idToValue(opt.id))}
            />
            <span className="tpl-card-glyph" aria-hidden="true">
              {opt.glyph}
            </span>
            <span className="tpl-card-name">{opt.label}</span>
            <span className="tpl-card-desc">{opt.description}</span>
          </label>
        );
      })}
    </div>
  );
}
