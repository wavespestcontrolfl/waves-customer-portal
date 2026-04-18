import React, { forwardRef } from 'react';
import { cn } from './cn';

export const Switch = forwardRef(function Switch(
  { checked, onChange, disabled, className, label, id, ...rest },
  ref
) {
  const toggle = (
    <button
      ref={ref}
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange && onChange(!checked)}
      className={cn(
        'relative inline-flex items-center h-4 w-7 rounded-full transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:ring-offset-1',
        checked ? 'bg-zinc-900' : 'bg-zinc-300',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
      {...rest}
    >
      <span
        className={cn(
          'inline-block w-3 h-3 rounded-full bg-white transition-transform',
          checked ? 'translate-x-[14px]' : 'translate-x-[2px]'
        )}
      />
    </button>
  );
  if (!label) return toggle;
  return (
    <label htmlFor={id} className="inline-flex items-center gap-2 cursor-pointer text-13 text-zinc-900">
      {toggle}
      <span>{label}</span>
    </label>
  );
});
