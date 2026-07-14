/**
 * Inspector control for Camera.postEffects — a stack of screen-space
 * post-processing effects (PostEffect[], a discriminated union on `type`;
 * see PostEffectSchema in @hearth/core). One card per effect: a type label,
 * a typed input per scalar field (reusing NumberField/ColorField from
 * ui.tsx so a bloom.strength number or a vignette.color swatch reads
 * exactly like any other component field), ↑/↓ reorder, and a remove
 * button, plus an "Add effect" dropdown of the 6 variant types capped at 8
 * (Camera.postEffects.max(8) in the schema). Never falls through to
 * JsonField — Jake: no raw JSON for a typed field, ever.
 *
 * Every user action commits the WHOLE next stack via one
 * setComponentProperty (Camera.postEffects, quiet) — the array-editing
 * logic itself lives in ../postEffectsList so it stays unit-testable
 * without a DOM, matching Vec2ListField/TileAssetsField.
 */
import React from 'react';
import { POST_EFFECT_TYPES, type PostEffect, type PostEffectType } from '@hearth/core';
import { POST_EFFECTS_MAX, addEffect, moveEffect, removeEffect, updateEffect } from '../postEffectsList';
import { ColorField, Icon, NumberField } from './ui';
import { IconButton } from './ui/Button';
import { Tooltip } from './ui/Tooltip';

/** Effect types whose title case reads as an unfinished word ("Crt") rather
 * than the acronym everyone actually calls it — checked before the generic
 * word-split transform below. */
const ACRONYMS: Partial<Record<PostEffectType, string>> = {
  crt: 'CRT',
};

/** camelCase variant name -> "Title Case With Spaces" for the type label and add-dropdown. */
export function humanize(type: string): string {
  const acronym = ACRONYMS[type as PostEffectType];
  if (acronym) return acronym;
  return type.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

function EffectFieldRow({
  field,
  value,
  onCommit,
}: {
  field: string;
  value: number | string;
  onCommit: (v: number | string) => void;
}) {
  let control: React.ReactNode;
  if (typeof value === 'number') {
    control = <NumberField value={value} onCommit={onCommit} />;
  } else if (typeof value === 'string' && value.startsWith('#')) {
    control = <ColorField value={value} onCommit={onCommit} />;
  } else {
    // No current PostEffect variant has a non-number/non-color scalar field,
    // but fall back to a plain text input rather than silently dropping an
    // unrecognized field (still typed — never JsonField).
    control = (
      <input className="input" value={String(value)} onChange={(e) => onCommit(e.target.value)} />
    );
  }
  return (
    <div className="inspector-row" key={field}>
      <label className="field-label" title={field}>
        {field}
      </label>
      {control}
    </div>
  );
}

function EffectCard({
  effect,
  index,
  count,
  onCommitField,
  onMove,
  onRemove,
}: {
  effect: PostEffect;
  index: number;
  count: number;
  onCommitField: (field: string, value: number | string) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const fields = Object.entries(effect).filter(([field]) => field !== 'type') as Array<
    [string, number | string]
  >;
  return (
    <div className="effect-card">
      <div className="effect-card-header">
        <span className="effect-card-title">{humanize(effect.type)}</span>
        <span style={{ flex: 1 }} />
        <Tooltip content="Move up">
          <button
            type="button"
            className="icon-btn"
            aria-label="Move effect up"
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            <span aria-hidden="true">&uarr;</span>
          </button>
        </Tooltip>
        <Tooltip content="Move down">
          <button
            type="button"
            className="icon-btn"
            aria-label="Move effect down"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
          >
            <span aria-hidden="true">&darr;</span>
          </button>
        </Tooltip>
        <IconButton
          bare
          className="icon-btn danger"
          icon="cross"
          iconSize={10}
          label="Remove effect"
          onClick={onRemove}
        />
      </div>
      <div className="effect-card-body">
        {fields.map(([field, value]) => (
          <EffectFieldRow
            key={field}
            field={field}
            value={value}
            onCommit={(v) => onCommitField(field, v)}
          />
        ))}
      </div>
    </div>
  );
}

export function PostEffectsField({
  value,
  onCommit,
}: {
  value: PostEffect[];
  onCommit: (next: PostEffect[]) => void;
}) {
  const atCap = value.length >= POST_EFFECTS_MAX;
  return (
    <div className="effect-list">
      {value.length === 0 && <span className="vec2-list-empty">No post effects</span>}
      {value.map((effect, i) => (
        <EffectCard
          key={i}
          effect={effect}
          index={i}
          count={value.length}
          onCommitField={(field, v) => onCommit(updateEffect(value, i, field, v))}
          onMove={(dir) => {
            const next = moveEffect(value, i, dir);
            if (next) onCommit(next);
          }}
          onRemove={() => onCommit(removeEffect(value, i))}
        />
      ))}
      <select
        className="select"
        value=""
        disabled={atCap}
        onChange={(e) => {
          const type = e.target.value as PostEffectType;
          if (!type) return;
          const next = addEffect(value, type);
          if (next) onCommit(next);
        }}
      >
        <option value="" disabled>
          {atCap ? `Stack full (max ${POST_EFFECTS_MAX})` : 'Add effect…'}
        </option>
        {POST_EFFECT_TYPES.map((type) => (
          <option key={type} value={type}>
            {humanize(type)}
          </option>
        ))}
      </select>
    </div>
  );
}
