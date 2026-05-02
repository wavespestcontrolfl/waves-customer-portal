import React, { forwardRef } from 'react';
import { cn } from './cn';

const BASE =
  'block w-full bg-white text-zinc-900 appearance-none pr-8 ' +
  'border-hairline border-zinc-300 rounded-sm ' +
  'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900 ' +
  'disabled:bg-zinc-50 disabled:text-ink-disabled disabled:cursor-not-allowed';

const SIZES = {
  sm: 'h-7 px-2 text-12',
  md: 'h-9 px-3 text-13',
};

const CARET =
  'bg-no-repeat bg-[right_0.5rem_center] bg-[length:0.6rem]';

const CARET_STYLE = {
  backgroundImage: "url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20viewBox='0%200%2010%206'%3E%3Cpath%20d='M1%201l4%204%204-4'%20stroke='%2352525B'%20stroke-width='1'%20fill='none'%20stroke-linecap='round'%20stroke-linejoin='round'/%3E%3C/svg%3E\")",
};

export const Select = forwardRef(function Select(
  { size = 'md', className, children, style, ...rest },
  ref
) {
  return (
    <select
      ref={ref}
      className={cn(BASE, SIZES[size], CARET, className)}
      style={{ ...CARET_STYLE, ...style }}
      {...rest}
    >
      {children}
    </select>
  );
});
