// Mobile-only scrollable day strip for the Dispatch day view.
//
// Replaces the fixed 7-pill row (selected ±3) with a horizontally
// scrollable window of days that extends itself at either end, a month
// label that tracks whichever days are in view, and a heavier rule at
// each month boundary. Scrolling only browses — the selected date (and
// the schedule fetch behind it) changes on tap, and Prev / Next / Today /
// client-search jumps re-center the strip on the new date.
//
// All date math is ET-calendar via lib/timezone (noon-UTC anchors), the
// same convention the page's own helpers use.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '../ui';
import { addETDays, etDateString } from '../../lib/timezone';

const DAYS_BACK = 60;
const DAYS_FORWARD = 120;
const EXTEND_BY = 30;
// Re-seed the window around the selection when a jump lands this close
// to an edge (or outside it) so there is always room to scroll both ways.
const EDGE_GUARD = 7;
const EXTEND_THRESHOLD_PX = 200;

function anchor(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
}

function shiftISO(iso, days) {
  return etDateString(addETDays(anchor(iso), days));
}

// One record per day in [start, end]; built once per range (the page
// re-renders on every fetch / modal / status change, and each record costs
// several Intl formats).
function buildDays(start, end) {
  const out = [];
  for (let iso = start; iso <= end; iso = shiftISO(iso, 1)) {
    const d = anchor(iso);
    const dow = d.getUTCDay();
    out.push({
      iso,
      dayNum: d.getUTCDate(),
      weekend: dow === 0 || dow === 6,
      firstOfMonth: d.getUTCDate() === 1,
      weekday: d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short' }),
      monthShort: d.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short' }),
    });
  }
  return out;
}

function monthLabel(iso) {
  return anchor(iso).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  });
}

function seedRange(iso) {
  return { start: shiftISO(iso, -DAYS_BACK), end: shiftISO(iso, DAYS_FORWARD) };
}

export default function MobileDayStrip({ date, onSelect }) {
  const [range, setRange] = useState(() => seedRange(date));
  const [visibleMonth, setVisibleMonth] = useState(() => monthLabel(date));
  const listRef = useRef(null);
  // scrollWidth captured before a prepend so the viewport stays put.
  const prependWidthRef = useRef(null);
  const extendingRef = useRef(false);
  const mountedRef = useRef(false);
  const rafRef = useRef(0);
  const days = useMemo(() => buildDays(range.start, range.end), [range]);
  const today = etDateString();

  const updateVisibleMonth = useCallback(() => {
    const list = listRef.current;
    // No layout (jsdom, or not yet painted): nothing measurable, keep the
    // label pinned to the selected date.
    if (!list || list.clientWidth === 0) return;
    const left = list.getBoundingClientRect().left;
    const first = Array.from(list.children).find(
      (el) => el.getBoundingClientRect().left >= left - 1,
    );
    if (first?.dataset.iso) setVisibleMonth(monthLabel(first.dataset.iso));
  }, []);

  const centerOn = useCallback(
    (iso, smooth) => {
      const list = listRef.current;
      const el = list?.querySelector(`[data-iso="${iso}"]`);
      if (!list || !el) return;
      const left = el.offsetLeft - (list.clientWidth - el.offsetWidth) / 2;
      if (typeof list.scrollTo === 'function') {
        list.scrollTo({ left, behavior: smooth ? 'smooth' : 'auto' });
      } else {
        list.scrollLeft = left;
      }
      updateVisibleMonth();
    },
    [updateVisibleMonth],
  );

  // Selection changed (tap, Prev/Next, Today, search jump): keep it in
  // the window and bring it to the middle of the strip.
  useEffect(() => {
    const outside =
      date < shiftISO(range.start, EDGE_GUARD) ||
      date > shiftISO(range.end, -EDGE_GUARD);
    setVisibleMonth(monthLabel(date));
    if (outside) {
      setRange(seedRange(date));
      return;
    }
    centerOn(date, mountedRef.current);
    mountedRef.current = true;
    // range is intentionally read, not tracked — re-seeding it triggers
    // the layout effect below, which re-centers without animation.
  }, [date, centerOn]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (prependWidthRef.current != null) {
      list.scrollLeft += list.scrollWidth - prependWidthRef.current;
      prependWidthRef.current = null;
      extendingRef.current = false;
      return;
    }
    if (extendingRef.current) {
      extendingRef.current = false;
      return;
    }
    // Fresh seed (mount or a jump outside the window): snap, no animation.
    centerOn(date, false);
    mountedRef.current = true;
  }, [range]);

  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const handleScroll = () => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(updateVisibleMonth);

    const list = listRef.current;
    if (!list || extendingRef.current) return;
    const nearStart = list.scrollLeft < EXTEND_THRESHOLD_PX;
    const nearEnd =
      list.scrollWidth - list.clientWidth - list.scrollLeft < EXTEND_THRESHOLD_PX;
    if (nearStart) {
      extendingRef.current = true;
      prependWidthRef.current = list.scrollWidth;
      setRange((r) => ({ ...r, start: shiftISO(r.start, -EXTEND_BY) }));
    } else if (nearEnd) {
      extendingRef.current = true;
      setRange((r) => ({ ...r, end: shiftISO(r.end, EXTEND_BY) }));
    }
  };

  // Roving focus: only the selected day sits in the tab order; arrows walk
  // the strip without leaving it.
  const handleKeyDown = (e) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const current = e.target.closest?.('[data-iso]')?.dataset.iso;
    if (!current) return;
    const next = listRef.current?.querySelector(`[data-iso="${shiftISO(current, step)}"]`);
    if (!next) return;
    e.preventDefault();
    next.focus();
    next.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  };

  return (
    <div className="mb-4">
      <div
        className="px-1 pb-1.5 text-12 uppercase tracking-label font-medium text-zinc-900 u-nums"
        aria-live="polite"
      >
        {visibleMonth}
      </div>
      <div
        ref={listRef}
        onScroll={handleScroll}
        onKeyDown={handleKeyDown}
        className="relative flex gap-1.5 overflow-x-auto px-1 pt-0.5 pb-1.5 snap-x snap-proximity overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        role="listbox"
        aria-label="Pick a day"
      >
        {days.map(({ iso, dayNum, weekend, firstOfMonth, weekday, monthShort }) => {
          const selected = iso === date;
          return (
            <button
              key={iso}
              type="button"
              role="option"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              data-iso={iso}
              onClick={() => onSelect(iso)}
              className={cn(
                'relative snap-start flex-shrink-0 w-[46px] h-14 rounded-sm border-hairline u-focus-ring transition-colors flex flex-col items-center justify-center gap-0.5',
                selected
                  ? 'bg-zinc-900 text-white border-zinc-900'
                  : 'bg-white text-zinc-900 border-zinc-300 hover:bg-zinc-50',
                firstOfMonth &&
                  !selected &&
                  'ml-3 border-l-[1.5px] border-l-zinc-500',
                firstOfMonth && selected && 'ml-3',
              )}
            >
              {firstOfMonth && (
                <span
                  aria-hidden="true"
                  className="absolute -left-3 top-1/2 -translate-y-1/2 rotate-180 [writing-mode:vertical-rl] text-11 uppercase tracking-label font-medium text-zinc-400 leading-none"
                >
                  {monthShort}
                </span>
              )}
              <span
                className={cn(
                  'text-11 uppercase tracking-label font-medium leading-none',
                  selected ? 'text-white' : 'text-zinc-400',
                )}
              >
                {weekday}
              </span>
              <span
                className={cn(
                  'u-nums text-16 font-medium leading-none',
                  !selected && weekend && 'text-zinc-600',
                )}
              >
                {dayNum}
              </span>
              {iso === today && (
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute bottom-1.5 w-1 h-1 rounded-full',
                    selected ? 'bg-white' : 'bg-zinc-900',
                  )}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
