import { useEffect } from 'react';

// Lock background page scroll while a modal / sheet / full-screen overlay is
// open. Fixes iOS "scroll bleed": without this, dragging inside an overlay
// scrolls the page behind it and loses the reader's place when the overlay
// closes.
//
// iOS Safari ignores `overflow: hidden` on <body> for touch scrolling, so we
// use the position:fixed technique — pin the body at its current scroll offset
// and restore it (and the scroll position) on unlock. Reference-counted so two
// overlays open at once don't stomp each other's saved offset.
//
// Usage: call `useLockBodyScroll(isOpen)` inside the overlay component. Passing
// a falsy value is a no-op, so it's safe to call unconditionally at the top of
// a component that conditionally renders its overlay.

let lockCount = 0;
let savedScrollY = 0;
let savedBody = null;
let savedRoot = null;
let lockMode = null;

function lock(preserveSticky) {
  lockCount += 1;
  if (lockCount > 1) return; // already locked by an outer overlay

  savedScrollY = window.scrollY || window.pageYOffset || 0;
  lockMode = preserveSticky ? 'root' : 'body';

  // Header-anchored menus must keep their sticky containing block in place.
  // Pinning <body> moves the entire sticky header by -scrollY, so these
  // surfaces lock the root scroller without changing body positioning.
  if (preserveSticky) {
    const { style } = document.documentElement;
    savedRoot = {
      overflow: style.overflow,
      overscrollBehavior: style.overscrollBehavior,
    };
    style.overflow = 'hidden';
    style.overscrollBehavior = 'none';
    return;
  }

  const { style } = document.body;
  savedBody = {
    position: style.position,
    top: style.top,
    left: style.left,
    right: style.right,
    width: style.width,
    overflow: style.overflow,
  };

  style.position = 'fixed';
  style.top = `-${savedScrollY}px`;
  style.left = '0';
  style.right = '0';
  style.width = '100%';
  style.overflow = 'hidden';
}

function unlock() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount > 0) return; // an outer overlay is still open

  if (lockMode === 'root') {
    const { style } = document.documentElement;
    if (savedRoot) {
      style.overflow = savedRoot.overflow;
      style.overscrollBehavior = savedRoot.overscrollBehavior;
      savedRoot = null;
    }
  } else {
    const { style } = document.body;
    if (savedBody) {
      style.position = savedBody.position;
      style.top = savedBody.top;
      style.left = savedBody.left;
      style.right = savedBody.right;
      style.width = savedBody.width;
      style.overflow = savedBody.overflow;
      savedBody = null;
    }
  }
  lockMode = null;
  // Restore the scroll position the body was pinned at.
  window.scrollTo(0, savedScrollY);
}

export default function useLockBodyScroll(active = true, { preserveSticky = false } = {}) {
  useEffect(() => {
    if (!active) return undefined;
    lock(preserveSticky);
    return unlock;
  }, [active, preserveSticky]);
}
