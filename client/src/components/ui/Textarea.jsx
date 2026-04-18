import React, { forwardRef } from 'react';
import { cn } from './cn';

const BASE =
  'block w-full bg-white text-zinc-900 placeholder:text-ink-disabled ' +
  'border-hairline border-zinc-300 rounded-sm py-2 px-3 text-13 ' +
  'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 ' +
  'disabled:bg-zinc-50 disabled:text-ink-disabled disabled:cursor-not-allowed ' +
  'resize-y';

export const Textarea = forwardRef(function Textarea(
  { rows = 4, className, ...rest },
  ref
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(BASE, className)}
      {...rest}
    />
  );
});
