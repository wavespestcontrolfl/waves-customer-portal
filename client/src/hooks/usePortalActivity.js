import { useEffect } from 'react';
import { flushPendingPushOpen, reportPortalPageView } from '../lib/portalActivity';

const DEBOUNCE_MS = 800;

/**
 * Beacon a portal tab view once the customer has stayed on `route` for a
 * moment (a quick tab-hop never fires). Debounced and entirely
 * fire-and-forget — it never touches render. Nothing is sent while the page
 * is hidden: a view scheduled hidden waits for the next visibilitychange to
 * visible, and every return to the foreground re-reports the current tab
 * (the lib dedupes a repeat inside its window), because these beacons are the
 * only writers of last_seen_at.
 */
export default function usePortalActivity(route) {
  // A push open whose beacon was cut off by the tap's page navigation.
  useEffect(() => { flushPendingPushOpen(); }, []);
  useEffect(() => {
    if (!route) return undefined;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (!hidden()) reportPortalPageView(route);
      }, DEBOUNCE_MS);
    };
    const onVisibility = () => { if (!hidden()) schedule(); };
    if (!hidden()) schedule();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [route]);
}
