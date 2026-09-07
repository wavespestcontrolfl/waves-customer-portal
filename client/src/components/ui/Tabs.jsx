import React, { createContext, useContext, useId } from 'react';
import { cn } from './cn';

const TabsCtx = createContext(null);

export function Tabs({ value, onValueChange, children, className }) {
  const base = useId();
  return (
    <TabsCtx.Provider value={{ value, onValueChange, base }}>
      <div className={className}>{children}</div>
    </TabsCtx.Provider>
  );
}

// Roving tabindex: only the active tab is in the Tab order; Arrow keys,
// Home and End move focus AND selection across the enabled tabs (WAI-ARIA
// tabs pattern), so the tab strip is keyboard-operable like a native one.
function moveFocus(list, current, key) {
  const tabs = Array.from(list.querySelectorAll('[role="tab"]:not([disabled])'));
  if (tabs.length === 0) return null;
  const i = tabs.indexOf(current);
  let next = i;
  if (key === 'ArrowRight') next = (i + 1) % tabs.length;
  else if (key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
  else if (key === 'Home') next = 0;
  else if (key === 'End') next = tabs.length - 1;
  else return null;
  return tabs[next];
}

export function TabList({ className, children, onKeyDown, ...rest }) {
  const ctx = useContext(TabsCtx);
  return (
    <div
      role="tablist"
      className={cn(
        'flex items-center gap-4 border-b border-hairline border-zinc-200',
        className
      )}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        const target = moveFocus(e.currentTarget, e.target, e.key);
        if (!target) return;
        e.preventDefault();
        target.focus();
        const value = target.getAttribute('data-value');
        if (ctx && ctx.onValueChange && value != null) ctx.onValueChange(value);
      }}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Tab({ value, children, className, disabled, ...rest }) {
  const ctx = useContext(TabsCtx);
  const active = ctx && ctx.value === value;
  const base = ctx?.base;
  return (
    <button
      type="button"
      role="tab"
      id={base ? `${base}-tab-${value}` : undefined}
      aria-controls={base ? `${base}-panel-${value}` : undefined}
      aria-selected={!!active}
      tabIndex={active ? 0 : -1}
      data-value={value}
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
  const base = ctx.base;
  return (
    <div
      role="tabpanel"
      id={base ? `${base}-panel-${value}` : undefined}
      aria-labelledby={base ? `${base}-tab-${value}` : undefined}
      tabIndex={0}
      className={cn('pt-4', className)}
      {...rest}
    >
      {children}
    </div>
  );
}
