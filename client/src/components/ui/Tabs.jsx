import React, { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { cn } from './cn';
import { useUiDensity } from './UiSurface';
import { Button } from './Button';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const TabsCtx = createContext(null);

export function Tabs({ value, onValueChange, children, className, variant = 'line' }) {
  const base = useId();
  // Rendered panels register themselves so a Tab only claims aria-controls
  // for a panel that is in the DOM — inactive panels render null, and some
  // call sites use Tabs as a bare filter strip with no panels at all.
  // The set lives in a ref and registerPanel is stable, so a panel's mount
  // effect runs once; a version bump re-renders consumers only when the
  // set actually changes (an unstable callback here looped the effect).
  const panelsRef = useRef(new Set());
  const [, bump] = useState(0);
  const registerPanel = useCallback((v) => {
    if (!panelsRef.current.has(v)) {
      panelsRef.current.add(v);
      bump((n) => n + 1);
    }
    return () => {
      if (panelsRef.current.delete(v)) bump((n) => n + 1);
    };
  }, []);
  return (
    <TabsCtx.Provider value={{ value, onValueChange, base, panels: panelsRef.current, registerPanel, variant }}>
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

// Record sections share one overflow behavior. Keyboard selection and resize
// reveal the selected tab without scrolling the surrounding page.
function ScrollableTabs({ children, active }) {
  const strip = useRef(null);
  const [edges, setEdges] = useState({ overflow: false, left: false, right: false });
  const measure = useCallback(() => {
    const node = strip.current;
    if (!node) return;
    setEdges({ overflow: node.scrollWidth > node.clientWidth + 2, left: node.scrollLeft > 2, right: node.scrollLeft + node.clientWidth < node.scrollWidth - 2 });
  }, []);
  const reveal = useCallback(() => {
    const node = strip.current;
    const selected = node?.querySelector('[aria-selected="true"]');
    if (!selected) return;
    const bounds = node.getBoundingClientRect(), item = selected.getBoundingClientRect();
    if (item.left < bounds.left + 8) node.scrollLeft -= bounds.left + 8 - item.left;
    else if (item.right > bounds.right - 8) node.scrollLeft += item.right - bounds.right + 8;
    measure();
  }, [measure]);
  useEffect(() => {
    reveal();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(reveal);
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, [reveal]);
  useEffect(reveal, [active, edges.overflow, children, reveal]);
  return <div className="ui-tab-navigation">
    {edges.overflow && <Button variant="ghost" className="ui-tab-arrow" aria-label="Scroll sections left" disabled={!edges.left} onClick={() => strip.current.scrollBy({ left: -220, behavior: 'instant' })}><ChevronLeft size={18} aria-hidden /></Button>}
    <div ref={strip} className="ui-tab-strip" onScroll={measure}>{children}</div>
    {edges.overflow && <Button variant="ghost" className="ui-tab-arrow" aria-label="Scroll sections right" disabled={!edges.right} onClick={() => strip.current.scrollBy({ left: 220, behavior: 'instant' })}><ChevronRight size={18} aria-hidden /></Button>}
  </div>;
}

export function TabList({ className, children, onKeyDown, scrollable = false, ...rest }) {
  const ctx = useContext(TabsCtx);
  const list = (
    <div
      role="tablist"
      className={cn(
        ctx?.variant === 'section' ? 'ui-section-list flex items-center' : 'flex items-center gap-4 border-b border-hairline border-zinc-200',
        className
      )}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        const target = moveFocus(e.currentTarget, e.target, e.key);
        if (!target) return;
        e.preventDefault();
        target.focus({ preventScroll: true });
        const value = target.getAttribute('data-value');
        if (ctx && ctx.onValueChange && value != null) ctx.onValueChange(value);
      }}
      {...rest}
    >
      {children}
    </div>
  );
  return scrollable ? <ScrollableTabs active={ctx?.value}>{list}</ScrollableTabs> : list;
}

export function Tab({ value, children, className, disabled, ...rest }) {
  const ctx = useContext(TabsCtx);
  const density = useUiDensity();
  const active = ctx && ctx.value === value;
  const base = ctx?.base;
  const hasPanel = !!(ctx && ctx.panels && ctx.panels.has(value));
  return (
    <button
      type="button"
      role="tab"
      id={base ? `${base}-tab-${value}` : undefined}
      aria-controls={base && hasPanel ? `${base}-panel-${value}` : undefined}
      aria-selected={!!active}
      tabIndex={active ? 0 : -1}
      data-value={value}
      disabled={disabled}
      onClick={() => ctx && ctx.onValueChange && ctx.onValueChange(value)}
      className={cn(
        ctx?.variant === 'section' ? 'ui-section-tab' : density === 'legacy' ? 'h-9 px-1 text-12 uppercase tracking-label font-medium' : 'ui-tab',
        'u-focus-ring',
        ctx?.variant !== 'section' && 'border-b-2 -mb-px transition-colors',
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

export function TabPanel({ value, children, className, keepMounted = false, style, ...rest }) {
  const ctx = useContext(TabsCtx);
  const register = ctx?.registerPanel;
  const active = !!(ctx && ctx.value === value);
  const mounted = active || keepMounted;
  // Draft forms explicitly retain their DOM/state; other consumers keep the
  // unmount policy. Register only panels that actually exist in the DOM.
  useEffect(() => (register && mounted ? register(value) : undefined), [register, value, mounted]);
  if (!mounted) return null;
  const base = ctx?.base;
  return (
    <div
      role="tabpanel"
      id={base ? `${base}-panel-${value}` : undefined}
      aria-labelledby={base ? `${base}-tab-${value}` : undefined}
      className={cn('pt-4', className)}
      {...rest}
      hidden={!active}
      inert={active ? undefined : ''}
      tabIndex={active ? 0 : -1}
      style={active ? style : { ...style, display: 'none' }}
    >
      {children}
    </div>
  );
}
