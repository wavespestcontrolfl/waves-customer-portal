import { useEffect } from 'react';
import { reportPortalHeartbeat, reportPortalPageView } from '../lib/portalActivity';

const DEBOUNCE_MS = 800;
// Foreground heartbeat: every minute, if the page is visible and the customer
// touched it in the last IDLE_MS, ask the lib to stamp last_seen_at (the lib
// holds the 5-minute floor). Hidden or idle sends nothing.
const HEARTBEAT_CHECK_MS = 60 * 1000;
const IDLE_MS = 5 * 60 * 1000;
const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'scroll', 'touchstart'];

/**
 * Beacon a portal tab view once the customer has stayed on `route` for a
 * moment (a quick tab-hop never fires). Debounced and entirely
 * fire-and-forget — it never touches render. Nothing is sent while the page
 * is hidden: a view scheduled hidden waits for the next visibilitychange to
 * visible, and every return to the foreground re-reports the current tab
 * (the lib dedupes a repeat inside its window), because these beacons are the
 * only writers of last_seen_at. A long visible session on one tab would
 * otherwise never refresh it, so a heartbeat (lightweight endpoint, stamps
 * last_seen_at only, no page-view row) fires while the page is visible and the
 * customer has interacted recently.
 */
export default function usePortalActivity(route) {
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let lastInteraction = Date.now(); // the portal just mounted for a customer
    const touch = () => { lastInteraction = Date.now(); };
    const options = { passive: true, capture: true };
    INTERACTION_EVENTS.forEach((name) => window.addEventListener(name, touch, options));
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (Date.now() - lastInteraction > IDLE_MS) return;
      reportPortalHeartbeat();
    }, HEARTBEAT_CHECK_MS);
    return () => {
      clearInterval(timer);
      INTERACTION_EVENTS.forEach((name) => window.removeEventListener(name, touch, options));
    };
  }, []);
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
