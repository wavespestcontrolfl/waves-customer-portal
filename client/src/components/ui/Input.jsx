import React, { forwardRef } from 'react';
import { cn } from './cn';
import { CONTROL_DENSITIES, useUiDensity } from './UiSurface';

const BASE =
  'block box-border min-w-0 w-full bg-white text-zinc-900 placeholder:text-ink-disabled ' +
  'border-hairline border-zinc-300 rounded-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 ' +
  'disabled:bg-zinc-50 disabled:text-ink-disabled disabled:cursor-not-allowed';

const SIZES = {
  sm: 'h-11 px-2 text-16 md:h-7 md:text-12',
  md: 'h-11 px-3 text-16 md:h-9 md:text-13',
};

// The address autocomplete owns its native input/ref. It can share control
// presentation without replacing that behavior or copying the field CSS.
export function inputStyles({ size = 'md', density = 'legacy', className } = {}) {
  return cn('ui-control', BASE, density === 'legacy' ? SIZES[size] : cn('ui-input', CONTROL_DENSITIES[density]), className);
}

export const Input = forwardRef(function Input(
  { size = 'md', density, className, type = 'text', ...rest },
  ref
) {
  const resolvedDensity = useUiDensity(density);
  return (
    <input
      ref={ref}
      type={type}
      className={inputStyles({ size, density: resolvedDensity, className })}
      {...rest}
    />
  );
});
