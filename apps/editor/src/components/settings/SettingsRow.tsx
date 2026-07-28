/**
 * The two shapes every settings pane is built from.
 *
 * A group is a heading and the rows under it. A row is one decision: what it
 * is on the left, the control that changes it on the right, and a hairline
 * between it and the next one. That layout is doing real work — it puts every
 * control on the same vertical line, so a pane of twelve settings reads as a
 * list rather than as twelve small arrangements.
 *
 * `stacked` is for the ones that genuinely can't: a text area, a picker with
 * its own internals. They keep the label above and take the full width rather
 * than being squeezed into the right column, which is what makes the aligned
 * rows around them stay aligned.
 */
import React from 'react';

export function SettingsGroup({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="set-group">
      {title !== undefined && <h3 className="set-group-title">{title}</h3>}
      <div className="set-rows">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  hint,
  control,
  stacked = false,
  /** Ties the label to the control it names, when the control is one field. */
  htmlFor,
}: {
  label: string;
  hint?: React.ReactNode;
  control?: React.ReactNode;
  stacked?: boolean;
  htmlFor?: string;
}) {
  const text = (
    <div className="set-row-text">
      {htmlFor !== undefined ? (
        <label className="set-row-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="set-row-label">{label}</span>
      )}
      {hint !== undefined && <p className="set-row-hint">{hint}</p>}
    </div>
  );

  return (
    <div className={stacked ? 'set-row is-stacked' : 'set-row'}>
      {text}
      {control !== undefined && <div className="set-row-control">{control}</div>}
    </div>
  );
}
