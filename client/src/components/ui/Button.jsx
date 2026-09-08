import React, { forwardRef } from 'react';
import { cn } from './cn';
import { CONTROL_DENSITIES, useUiDensity } from './UiSurface';

const BASE =
  'ui-control inline-flex items-center justify-center font-medium ' +
  'select-none transition-colors u-focus-ring ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const SIZES = {
  sm: 'h-11 md:h-7 px-3 text-11 rounded-xs',
  md: 'h-11 md:h-9 px-4 text-12 rounded-sm',
};

const VARIANTS = {
  primary:
    'bg-zinc-900 text-white hover:bg-zinc-800 active:bg-zinc-950 border-hairline border-zinc-900',
  secondary:
    'bg-white text-zinc-900 border-hairline border-zinc-300 hover:bg-zinc-50 active:bg-zinc-100',
  ghost:
    'appearance-none border-0 bg-transparent text-zinc-700 hover:bg-zinc-100 active:bg-zinc-200',
  danger:
    'bg-alert-fg text-white hover:bg-alert-hover active:bg-alert-hover border-hairline border-alert-fg',
};

// Links with button presentation reuse these exact variants without changing
// their native navigation or introducing a second action implementation.
export function buttonStyles({ variant = 'primary', size = 'md', density = 'legacy', className } = {}) {
  return cn(BASE, density === 'legacy' ? cn('uppercase tracking-label', SIZES[size]) : cn('ui-action', CONTROL_DENSITIES[density]), VARIANTS[variant], className);
}

export const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', density, loading, disabled, className, type = 'button', ...rest },
  ref
) {
  const resolvedDensity = useUiDensity(density);
  return (
    <button
      ref={ref}
      type={type}
      className={buttonStyles({ variant, size, density: resolvedDensity, className: cn(loading !== undefined && 'ui-pending-action gap-2', className) })}
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading === undefined ? rest['aria-busy'] : loading || undefined}
    />
  );
});
