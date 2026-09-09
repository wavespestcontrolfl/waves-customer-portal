import React, { forwardRef } from 'react';
import { cn } from './cn';
import { CONTROL_DENSITIES, useUiDensity } from './UiSurface';

const BASE =
  'block box-border min-h-11 min-w-0 w-full bg-white text-zinc-900 placeholder:text-ink-disabled ' +
  'border-hairline border-zinc-300 rounded-sm py-2 px-3 ' +
  'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 ' +
  'disabled:bg-zinc-50 disabled:text-ink-disabled disabled:cursor-not-allowed ' +
  'resize-y';

export const Textarea = forwardRef(function Textarea(
  { rows = 4, density, className, ...rest },
  ref
) {
  const resolvedDensity = useUiDensity(density);
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn('ui-control', BASE, resolvedDensity === 'legacy' ? 'text-16 md:text-13' : CONTROL_DENSITIES[resolvedDensity], className)}
      {...rest}
    />
  );
});
