import React, { forwardRef } from 'react';
import { cn } from './cn';

export const Checkbox = forwardRef(function Checkbox(
  { className, label, id, ...rest },
  ref
) {
  const input = (
    <input
      ref={ref}
      type="checkbox"
      id={id}
      className={cn(
        'appearance-none w-4 h-4 rounded-xs bg-white',
        'border-hairline border-zinc-400',
        'checked:bg-zinc-900 checked:border-zinc-900',
        'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1',
        'relative cursor-pointer',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        "checked:after:content-[''] checked:after:absolute checked:after:left-[3px] checked:after:top-[0px]",
        'checked:after:w-[6px] checked:after:h-[10px]',
        'checked:after:border-r-[1.5px] checked:after:border-b-[1.5px] checked:after:border-white',
        'checked:after:rotate-45',
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
