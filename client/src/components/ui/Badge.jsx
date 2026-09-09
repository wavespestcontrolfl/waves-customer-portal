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
  // An unknown tone used to drop out of cn() silently — an invisible chip
  // with bare uppercase text. Fall back to neutral and say so in dev.
  const known = Object.prototype.hasOwnProperty.call(TONES, tone);
  if (!known && import.meta.env.DEV) {
    console.warn(`Badge: unknown tone "${tone}" — rendering neutral`);
  }
  const resolved = known ? tone : 'neutral';
  return (
    <span className={cn(BASE, TONES[resolved], className)} {...rest}>
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full', DOT_TONES[resolved])} />}
      {children}
    </span>
  );
}
