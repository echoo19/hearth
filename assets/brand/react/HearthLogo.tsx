import * as React from 'react';

const MARK_PATH =
  'M10 26 A14 14 0 0 1 38 26 L38 39 A3 3 0 0 1 35 42 L13 42 A3 3 0 0 1 10 39 Z ' +
  'M23.9 38.6 C 19.8 38.6, 16.8 35.7, 16.8 31.8 C 16.8 26.9, 21.4 24.9, 24.4 16.0 ' +
  'C 27.5 19.7, 31.1 24.7, 31.1 30.1 C 31.1 35.2, 27.9 38.6, 23.9 38.6 Z';

export interface HearthLogoProps extends React.SVGProps<SVGSVGElement> {
  /** Rendered size in px (width = height). Default 32. */
  size?: number;
  /**
   * "mono" (default) renders in currentColor — drop it into any text context.
   * "ember" renders the brand gradient (#E5484D → #F76B15 → #FFA057); use on
   * dark grounds only.
   */
  variant?: 'mono' | 'ember';
  /** Accessible label. Pass an empty string for decorative use. */
  title?: string;
}

/**
 * HearthLogo — the "Kept Flame" mark of the Hearth game engine
 * (https://github.com/echoo19/hearth).
 *
 * One solid hearth arch with the flame kept as negative space (a single
 * evenodd path, 48×48 grid). Legible down to 16px. Brand palette: ember
 * #F76B15 on hearthstone #141019 / warm paper #F4F1EC.
 */
export default function HearthLogo({
  size = 32,
  variant = 'mono',
  title = 'Hearth',
  ...rest
}: HearthLogoProps) {
  const gradientId = React.useId();
  return (
    <svg
      viewBox="0 0 48 48"
      width={size}
      height={size}
      role={title ? 'img' : 'presentation'}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      {...rest}
    >
      {variant === 'ember' && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="1" x2="0" y2="0">
            <stop offset="0" stopColor="#e5484d" />
            <stop offset="0.55" stopColor="#f76b15" />
            <stop offset="1" stopColor="#ffa057" />
          </linearGradient>
        </defs>
      )}
      <path
        d={MARK_PATH}
        fillRule="evenodd"
        fill={variant === 'ember' ? `url(#${gradientId})` : 'currentColor'}
      />
    </svg>
  );
}
