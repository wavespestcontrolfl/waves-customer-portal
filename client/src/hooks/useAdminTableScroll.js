import { useEffect, useLayoutEffect, useRef } from 'react';

// The admin shell scrolls #admin-main, not window. Restore only a visible,
// settled list; scrolling a record must not replace its list's return position.
export function useAdminTableScroll({ enabled, active, ready, scope, scrollTop, onScroll, resetKey }) {
  const latest = useRef(null);
  latest.current = { enabled, active, ready, scope, onScroll, resetKey };
  const pending = useRef(null);
  const timer = useRef(null);
  const reported = useRef(null);
  const restoring = useRef(false);
  const previous = useRef(null);
  const cancelRestore = useRef(() => {});

  useLayoutEffect(() => {
    if (!enabled || !active || !ready || !scope) return undefined;
    const container = document.getElementById('admin-main');
    if (!container) return undefined;
    const flush = () => {
      clearTimeout(timer.current);
      const position = pending.current;
      pending.current = null;
      const current = latest.current;
      // A late timer/cleanup belongs to the old query and identity. It must
      // never replace a new account's settings or a deliberate page reset.
      if (!position || current.scope !== scope || position.resetKey !== current.resetKey) return;
      reported.current = { scope, value: position.value };
      current.onScroll(position.value);
    };
    const track = () => {
      const current = latest.current;
      if (restoring.current || !current.enabled || !current.active || !current.ready || current.scope !== scope) return;
      pending.current = { value: Math.max(0, container.scrollTop), resetKey: current.resetKey };
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 150);
    };
    const interrupt = () => cancelRestore.current();
    container.addEventListener('scroll', track, { passive: true });
    container.addEventListener('wheel', interrupt, { passive: true });
    container.addEventListener('touchstart', interrupt, { passive: true });
    window.addEventListener('pagehide', flush);
    return () => {
      container.removeEventListener('scroll', track);
      container.removeEventListener('wheel', interrupt);
      container.removeEventListener('touchstart', interrupt);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [enabled, active, ready, scope]);

  useEffect(() => {
    const before = previous.current;
    previous.current = { enabled, active, ready, scope, resetKey };
    if (!enabled || !active || !ready || !scope) return undefined;
    const container = document.getElementById('admin-main');
    if (!container) return undefined;
    const changed = !before?.enabled || !before.active || !before.ready
      || before.scope !== scope || before.resetKey !== resetKey;
    if (!changed && reported.current?.scope === scope && reported.current.value === scrollTop) return undefined;

    clearTimeout(timer.current);
    pending.current = null;
    restoring.current = true;
    let frame;
    const cancel = () => {
      cancelAnimationFrame(frame);
      restoring.current = false;
    };
    cancelRestore.current = cancel;
    // The shell resets pathname navigation in a passive effect. Two frames
    // also let the newly loaded rows establish their final scroll height.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
        container.scrollTo({ top, behavior: 'instant' });
        reported.current = { scope, value: container.scrollTop };
        if (container.scrollTop !== top) latest.current.onScroll(container.scrollTop);
        frame = requestAnimationFrame(() => { restoring.current = false; });
      });
    });
    return cancel;
  }, [enabled, active, ready, scope, scrollTop, resetKey]);
}
