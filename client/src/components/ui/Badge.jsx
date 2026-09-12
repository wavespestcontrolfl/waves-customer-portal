import React from 'react';
import { cn } from './cn';
import { useUiDensity } from './UiSurface';

const BASE =
  'inline-flex items-center gap-1 px-2 font-medium rounded-xs';

const TONES = {
  neutral: 'bg-zinc-100 text-zinc-700',
  strong: 'bg-zinc-900 text-white',
  warn: 'bg-warn-bg text-warn-fg',
  alert: 'bg-alert-bg text-alert-fg',
};

const DOT_TONES = {
  neutral: 'bg-zinc-500',
  strong: 'bg-zinc-900',
  warn: 'bg-warn-fg',
  alert: 'bg-alert-fg',
};

export function Badge({ tone = 'neutral', dot = false, density, className, children, ...rest }) {
  const resolvedDensity = useUiDensity(density);
  const known = Object.prototype.hasOwnProperty.call(TONES, tone);
  if (!known && import.meta.env.DEV) {
    console.warn(`Badge: unknown tone "${tone}" — rendering neutral`);
  }
  const resolved = known ? tone : 'neutral';
  return (
    <span className={cn(BASE, resolvedDensity === 'legacy' ? 'h-5 text-11 uppercase tracking-label' : 'min-h-6 text-14 leading-normal', TONES[resolved], className)} {...rest}>
      {dot && <span className={cn('w-1.5 h-1.5 rounded-full', DOT_TONES[resolved])} />}
      {children}
    </span>
  );
}
