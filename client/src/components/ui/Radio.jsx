import React, { forwardRef } from 'react';
import { cn } from './cn';

export const Radio = forwardRef(function Radio(
  { className, label, id, ...rest },
  ref
) {
  const input = (
    <input
      ref={ref}
      type="radio"
      id={id}
      className={cn(
        'appearance-none w-4 h-4 rounded-full bg-white',
        'border-hairline border-zinc-400',
        'checked:border-zinc-900',
        'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1',
        'relative cursor-pointer',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        "checked:after:content-[''] checked:after:absolute checked:after:inset-0",
        'checked:after:m-auto checked:after:w-[8px] checked:after:h-[8px]',
        'checked:after:rounded-full checked:after:bg-zinc-900',
        className
      )}
      {...rest}
    />
  );
  if (!label) return input;
  return (
    <label htmlFor={id} className="inline-flex items-center gap-2 cursor-pointer text-13 text-zinc-900">
      {input}
      <span>{label}</span>
    </label>
  );
});
