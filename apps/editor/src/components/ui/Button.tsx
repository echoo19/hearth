/**
 * Button / IconButton — the app's shared button primitives.
 *
 * Thin by design: both render the `.btn` class family, whose look and metrics
 * live in `styles/primitives.css` (comfortable --ctl-h height, generous
 * radius, hairline border, ghost as the icon-control default).
 *
 * IconButton always wraps itself in `Tooltip` — an icon-only control needs a
 * discoverable label whether or not it's hovered, so `label` is required and
 * doubles as both the `aria-label` and the tooltip content. It defaults to the
 * ghost variant and a square `.btn-icon` box, which is the app's icon-control
 * idiom everywhere.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon } from '../ui';
import { Tooltip, type TooltipSide } from './Tooltip';

/**
 * The five rungs of the ladder documented at the top of primitives.css.
 *
 * `quiet` is the one that was missing, and its absence is why text-only
 * actions spread: anything that should not shout got `ghost`, which draws
 * nothing at rest, so the control became indistinguishable from the labels
 * around it. Reach for `quiet` for an action in a strip that has to stay calm,
 * and keep `ghost` for icon-only controls and for text inside a container that
 * already draws its own boundary.
 */
export type ButtonVariant = 'default' | 'primary' | 'danger' | 'quiet' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: 'btn-primary',
  danger: 'btn-danger',
  quiet: 'btn-quiet',
  ghost: 'btn-ghost',
};

function btnClassName(variant: ButtonVariant, size: ButtonSize, className?: string): string {
  return ['btn', VARIANT_CLASS[variant], size === 'sm' ? 'btn-sm' : '', className]
    .filter(Boolean)
    .join(' ');
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Name from ui.tsx's Icon glyph set; rendered before children. */
  icon?: string;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, className, type = 'button', children, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={btnClassName(variant, size, className)} {...rest}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  /** Required: doubles as the aria-label and the Tooltip content. */
  label: string;
  shortcut?: string;
  side?: TooltipSide;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Glyph size in px, passed through to Icon (defaults to Icon's own 12). */
  iconSize?: number;
  /**
   * Skip the `.btn` base/variant/size classes and render `className`
   * verbatim, for an icon-only control that rides its own bespoke class
   * family while still getting the tooltip and the required aria-label.
   */
  bare?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, side, variant = 'ghost', size = 'md', iconSize, bare, className, type = 'button', ...rest },
  ref,
) {
  // Icon-only controls are square ghost targets by default (see `.btn-icon`):
  // a row of bordered boxes reads as a dense toolbar, which this app is not.
  const cls = bare ? (className ?? '') : btnClassName(variant, size, ['btn-icon', className].filter(Boolean).join(' '));
  return (
    <Tooltip content={label} shortcut={shortcut} side={side}>
      <button ref={ref} type={type} aria-label={label} className={cls} {...rest}>
        <Icon name={icon} size={iconSize} />
      </button>
    </Tooltip>
  );
});
