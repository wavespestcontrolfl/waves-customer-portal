import React from 'react';
import { cn } from './cn';

const BASE =
  'inline-flex items-center gap-1 h-5 px-2 text-11 font-medium rounded-xs ' +
  'uppercase tracking-label';

const TONES = {
  neutral: 'bg-zinc-100 text-zinc-700',
  strong: 'bg-zinc-900 text-white',
  alert: 'bg-alert-bg text-alert-fg',
};

const DOT_TONES = {
  neutral: 'bg-zinc-500',
  strong: 'bg-zinc-900',
  alert: 'bg-alert-fg',
};

export function Badge({ tone = 'neutral', dot = false, className, children, ...rest }) {
  return (
    <span className={cn(BASE, TONES[tone], className)} {...rest}>
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full', DOT_TONES[tone])} />}
      {children}
    </span>
  );
}
