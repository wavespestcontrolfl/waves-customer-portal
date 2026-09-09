import React, { forwardRef } from 'react';
import { cn } from './cn';

const BASE =
  'inline-flex items-center justify-center uppercase font-medium tracking-label ' +
  'select-none transition-colors u-focus-ring ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const SIZES = {
  sm: 'h-11 sm:h-7 px-3 text-11 rounded-xs',
  md: 'h-11 sm:h-9 px-4 text-12 rounded-sm',
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

export const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', className, type = 'button', ...rest },
  ref
) {
  // Same silent-undefined pattern as Badge: an unknown variant or size
  // rendered a bare <button>. Fall back and warn in dev.
  const hasVariant = Object.prototype.hasOwnProperty.call(VARIANTS, variant);
  const hasSize = Object.prototype.hasOwnProperty.call(SIZES, size);
  if (import.meta.env.DEV) {
    if (!hasVariant) console.warn(`Button: unknown variant "${variant}" — rendering primary`);
    if (!hasSize) console.warn(`Button: unknown size "${size}" — rendering md`);
  }
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        BASE,
        SIZES[hasSize ? size : 'md'],
        VARIANTS[hasVariant ? variant : 'primary'],
        className
      )}
      {...rest}
    />
  );
});
