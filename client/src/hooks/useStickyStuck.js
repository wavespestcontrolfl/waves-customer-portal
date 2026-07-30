import { useEffect, useRef, useState } from 'react';

// Reports whether a `position: sticky` element is currently pinned. Attach
// the returned ref to a zero-height sentinel rendered immediately BEFORE the
// sticky element in the flow — a sentinel inside it would pin along with the
// bar, so its own offset could never mark the pin point.
//
// The pin point is derived from the sentinel's document offset on every
// check (content above the bar can change height), so this works wherever
// the bar sits on the page. Hysteresis: consumers shrink the stuck bar (the
// pills row collapses) and scroll anchoring may then nudge scrollTop by the
// height delta — `collapsePastPx` (must exceed that delta) separates the
// stick and release thresholds so the bar can't oscillate. Release happens
// just past the pin point itself, so scrolling back up always restores the
// full bar even when it naturally sits near the top of the document.
export default function useStickyStuck(stickOffsetPx, collapsePastPx = 80) {
  const sentinelRef = useRef(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || typeof window === 'undefined') return undefined;
    let frame = 0;
    const check = () => {
      frame = 0;
      const node = sentinelRef.current;
      if (!node) return;
      const pinPoint = node.getBoundingClientRect().top + window.scrollY - stickOffsetPx;
      setStuck((prev) => (prev
        ? window.scrollY > pinPoint + 8
        : window.scrollY > pinPoint + collapsePastPx));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [stickOffsetPx, collapsePastPx]);

  return [stuck, sentinelRef];
}
