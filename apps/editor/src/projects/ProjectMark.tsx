/**
 * A project's mark: its glyph in its colour.
 *
 * One component, two sizes, used in three places — the Projects list, the tiny
 * badge on every chat row, and the composer's project selector — because a
 * project has to be recognisable as the SAME thing in all of them. That is the
 * entire point of giving it a mark: you learn "the teal grid" once.
 *
 * Colour is passed as a custom property rather than a style attribute so hover
 * and selected states can tint from it in CSS without JavaScript recomputing
 * anything.
 */
import React from 'react';
import { Icon } from '../components/ui';
import { resolveIdentity, type ProjectIdentity } from './identity';

export function ProjectMark({
  path,
  identity,
  size = 14,
  className,
}: {
  path: string;
  identity?: ProjectIdentity | null;
  size?: number;
  className?: string;
}) {
  const { icon, colorValue } = resolveIdentity(path, identity);
  return (
    <span
      className={className ? `project-mark ${className}` : 'project-mark'}
      style={{ '--mark': colorValue } as React.CSSProperties}
      aria-hidden="true"
    >
      <Icon name={icon} size={size} />
    </span>
  );
}
