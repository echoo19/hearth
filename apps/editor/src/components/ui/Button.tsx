/**
 * Button / IconButton — the editor's shared button primitives.
 *
 * Thin by design: this task introduces the primitive, not a new look — both
 * components render the exact `.btn` class family the editor already ships
 * (`.btn`, `.btn-primary`, `.btn-danger`, `.btn-ghost`, `.btn-sm`). Any new
 * rule this primitive needs lives in `styles/primitives/button.css`, not
 * here and not in `primitives.css`.
 *
 * IconButton always wraps itself in `Tooltip` (T3) — an icon-only control
 * needs a discoverable label whether or not it's hovered, so `label` is
 * required and doubles as both the `aria-label` and the tooltip content.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Icon } from '../ui';
import { Tooltip, type TooltipSide } from './Tooltip';

export type ButtonVariant = 'default' | 'primary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md';

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: 'btn-primary',
  danger: 'btn-danger',
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
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, shortcut, side, variant = 'default', size = 'md', iconSize, className, type = 'button', ...rest },
  ref,
) {
  return (
    <Tooltip content={label} shortcut={shortcut} side={side}>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        className={btnClassName(variant, size, className)}
        {...rest}
      >
        <Icon name={icon} size={iconSize} />
      </button>
    </Tooltip>
  );
});
