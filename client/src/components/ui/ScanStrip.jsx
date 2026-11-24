// Horizontal scan-and-tap picker: a scrollable strip of fixed-height tiles,
// one selected at a time. Same look as the schedule's MobileDayStrip, for any
// short list (programs, months, visits). Tiles size to their content; the
// strip scrolls inside its own box and never widens the page.

import { useEffect, useRef } from 'react';
import { cn } from './cn';

const KEY_STEP = { ArrowRight: 1, ArrowLeft: -1 };

export function ScanStrip({ items, selectedKey, onSelect, ariaLabel, className }) {
  const listRef = useRef(null);
  const selectedIndex = items.findIndex((item) => item.key === selectedKey);

  // Scroll only the strip, never the page: element.scrollIntoView would also
  // scroll every ancestor, so set the strip's own scrollLeft instead.
  const scrollIntoView = (el) => {
    const strip = listRef.current;
    if (!el || !strip) return;
    const left = el.offsetLeft; // the strip is `relative`, so this is strip-local
    const right = left + el.offsetWidth;
    if (left < strip.scrollLeft) strip.scrollLeft = left;
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
  };

  // Keep the selected tile in view when the selection changes (tap, arrow key,
  // or a parent reset).
  useEffect(() => {
    scrollIntoView(listRef.current?.children[selectedIndex]);
  }, [selectedIndex]);

  // Roving focus: only the selected tile sits in the tab order. Arrows, Home
  // and End move focus only; Enter, Space or a tap picks the focused tile.
  // Picking on focus would load every program the user arrows past, and a
  // pick the parent rolls back (a failed load) would trap the arrows.
  const handleKeyDown = (e) => {
    if (items.length === 0) return;
    const tiles = Array.from(listRef.current?.children || []);
    const focused = tiles.indexOf(document.activeElement);
    const from = focused >= 0 ? focused : Math.max(selectedIndex, 0);
    let to;
    if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = items.length - 1;
    else if (KEY_STEP[e.key]) to = Math.min(Math.max(from + KEY_STEP[e.key], 0), items.length - 1);
    else return;
    e.preventDefault();
    tiles[to]?.focus();
    scrollIntoView(tiles[to]);
  };

  return (
    <div
      ref={listRef}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative flex gap-1.5 overflow-x-auto px-1 pt-0.5 pb-1.5 snap-x snap-proximity overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className,
      )}
      role="listbox"
      aria-label={ariaLabel}
    >
      {items.map((item, i) => {
        const selected = item.key === selectedKey;
        return (
          <button
            key={item.key}
            type="button"
            role="option"
            aria-selected={selected}
            tabIndex={selected || (selectedIndex < 0 && i === 0) ? 0 : -1}
            aria-label={item.ariaLabel}
            onClick={() => onSelect(item.key)}
            className={cn(
              'snap-start flex-shrink-0 min-w-[64px] h-14 px-3 rounded-sm border-hairline u-focus-ring transition-colors flex flex-col items-center justify-center gap-0.5',
              selected
                ? 'bg-zinc-900 text-white border-zinc-900'
                : 'bg-white text-zinc-900 border-zinc-300 hover:bg-zinc-50',
            )}
          >
            {item.label && (
              <span
                className={cn(
                  'text-14 uppercase tracking-label font-medium leading-none whitespace-nowrap',
                  selected ? 'text-white' : 'text-zinc-400',
                )}
              >
                {item.label}
              </span>
            )}
            <span className="u-nums text-16 font-medium leading-none whitespace-nowrap">
              {item.value}
            </span>
          </button>
        );
      })}
    </div>
  );
}
