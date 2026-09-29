import { useEffect } from 'react';
import { flushPendingPushOpen, reportPortalPageView } from '../lib/portalActivity';

const DEBOUNCE_MS = 800;

/**
 * Beacon a portal tab view once the customer has stayed on `route` for a
 * moment (a quick tab-hop never fires). Debounced, deferred to the next
 * visibilitychange while the page is hidden, and entirely fire-and-forget — it never touches render.
 */
export default function usePortalActivity(route) {
  // A push open whose beacon was cut off by the tap's page navigation.
  useEffect(() => { flushPendingPushOpen(); }, []);
  useEffect(() => {
    if (!route) return undefined;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    let onVisible = null;
    const timer = setTimeout(() => {
      if (!hidden()) { reportPortalPageView(route); return; }
      // Scheduled while the page was hidden: send once, when it next becomes
      // visible (only if the customer is still on this tab — cleanup removes it).
      onVisible = () => {
        if (hidden()) return;
        document.removeEventListener('visibilitychange', onVisible);
        onVisible = null;
        reportPortalPageView(route);
      };
      document.addEventListener('visibilitychange', onVisible);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      if (onVisible) document.removeEventListener('visibilitychange', onVisible);
    };
  }, [route]);
}
