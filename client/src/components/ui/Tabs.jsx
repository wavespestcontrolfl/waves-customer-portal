import React, { createContext, useContext } from 'react';
import { cn } from './cn';

const TabsCtx = createContext(null);

export function Tabs({ value, onValueChange, children, className }) {
  return (
    <TabsCtx.Provider value={{ value, onValueChange }}>
      <div className={className}>{children}</div>
    </TabsCtx.Provider>
  );
}

export function TabList({ className, children, ...rest }) {
  return (
    <div
      role="tablist"
      className={cn(
        'flex items-center gap-4 border-b border-hairline border-zinc-200',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Tab({ value, children, className, disabled, ...rest }) {
  const ctx = useContext(TabsCtx);
  const active = ctx && ctx.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={!!active}
      disabled={disabled}
      onClick={() => ctx && ctx.onValueChange && ctx.onValueChange(value)}
      className={cn(
        'h-9 px-1 text-12 uppercase tracking-label font-medium',
        'border-b-2 -mb-px transition-colors u-focus-ring',
        active
          ? 'border-zinc-900 text-zinc-900'
          : 'border-transparent text-ink-secondary hover:text-zinc-900',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

export function TabPanel({ value, children, className, ...rest }) {
  const ctx = useContext(TabsCtx);
  if (!ctx || ctx.value !== value) return null;
  return (
    <div role="tabpanel" className={cn('pt-4', className)} {...rest}>
      {children}
    </div>
  );
}
