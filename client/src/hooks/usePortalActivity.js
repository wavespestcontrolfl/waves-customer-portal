import { useEffect } from 'react';
import { flushPendingPushOpen, reportPortalPageView } from '../lib/portalActivity';

const DEBOUNCE_MS = 800;

/**
 * Beacon a portal tab view once the customer has stayed on `route` for a
 * moment (a quick tab-hop never fires). Debounced, skipped while the page is
 * hidden, and entirely fire-and-forget — it never touches render.
 */
export default function usePortalActivity(route) {
  // A push open whose beacon was cut off by the tap's page navigation.
  useEffect(() => { flushPendingPushOpen(); }, []);
  useEffect(() => {
    if (!route) return undefined;
    const timer = setTimeout(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      reportPortalPageView(route);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [route]);
}
