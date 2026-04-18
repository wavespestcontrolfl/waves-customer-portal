import React, { forwardRef } from 'react';
import { cn } from './cn';

const BASE =
  'block w-full bg-white text-zinc-900 placeholder:text-ink-disabled ' +
  'border-hairline border-zinc-300 rounded-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 ' +
  'disabled:bg-zinc-50 disabled:text-ink-disabled disabled:cursor-not-allowed';

const SIZES = {
  sm: 'h-7 px-2 text-12',
  md: 'h-9 px-3 text-13',
};

export const Input = forwardRef(function Input(
  { size = 'md', className, type = 'text', ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(BASE, SIZES[size], className)}
      {...rest}
    />
  );
});
