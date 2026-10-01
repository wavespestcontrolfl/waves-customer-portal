/**
 * Shared auto-grow textarea sizing — client/src/hooks/useAutoGrowTextarea.js
 *
 * Extracted from the admin GlobalCommandPalette composer fix (#5218,
 * owner-reported bug: the composer was a single-line <input>, so dictated
 * text longer than the box couldn't be seen or edited past the cut-off).
 * Both the admin Intelligence Bar and the tech Intelligence Bar composers
 * use this hook — keep it in one place instead of per-surface DOM hacks.
 */
import { useRef, useLayoutEffect, useEffect } from 'react';

export function sizeComposer(el, maxHeight) {
  el.style.height = 'auto';
  // scrollHeight excludes the border; a border-box height must add it
  // back or the box ends up shorter than its content.
  const borders = el.offsetHeight - el.clientHeight;
  const full = el.scrollHeight + borders;
  const next = maxHeight ? Math.min(full, maxHeight) : full;
  el.style.height = `${next}px`;
  el.style.overflowY = maxHeight && full > maxHeight ? 'auto' : 'hidden';
}

export function useAutoGrowTextarea(ref, value, getMaxHeight, enabled = true) {
  // Runs after every render but measures only when the element, the value,
  // the cap or the width changed — so a textarea that MOUNTS already holding
  // text (a draft kept across close/reopen, the follow-up box appearing) is
  // sized too, not just one whose value changes while mounted.
  const lastRef = useRef({ el: null, value: null, maxHeight: null, width: null });
  const cap = () => (typeof getMaxHeight === 'function' ? getMaxHeight() : getMaxHeight);
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const maxHeight = cap();
    const width = el.clientWidth;
    const last = lastRef.current;
    if (last.el === el && last.value === value && last.maxHeight === maxHeight && last.width === width) return;
    lastRef.current = { el, value, maxHeight, width };
    sizeComposer(el, maxHeight);
  });
  // A viewport resize or rotation re-wraps the text without any render (the
  // mobile breakpoint may not change), so re-measure on window resize too.
  useEffect(() => {
    if (!enabled) return undefined;
    const onResize = () => {
      const el = ref.current;
      if (!el) return;
      const maxHeight = cap();
      lastRef.current = { el, value: el.value, maxHeight, width: el.clientWidth };
      sizeComposer(el, maxHeight);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [ref, getMaxHeight, enabled]); // cap() reads getMaxHeight, a per-call-site constant
}
