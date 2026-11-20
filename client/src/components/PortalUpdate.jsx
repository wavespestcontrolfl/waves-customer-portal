import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { Button } from './ui';
import { isAdminPath, isFieldPath } from '../lib/adminBookmarkMeta';
import { newerBuild, subscribePortalVersion } from '../lib/portalVersion';
import { reloadBlockers, reloadDueAtMove, reloadForNewBuild } from '../lib/portalReload';

// Wraps the route tree (App.jsx). At a page move that is due a reload
// (lib/portalReload.js) it shows `fallback` in place of the routes, so the old
// page closes and the new one does not start, then reloads. When something
// holds the reload, the routes come back and the Reload bar stays. The first
// page this tab loaded never reloads. The fallback drops nothing a move keeps:
// App.jsx's RoutesErrorBoundary keys the route tree on the pathname, so every
// page move already remounts the staff layout and all it holds in React state
// (the Ask Waves prompt included). Work that outlives a move is in a module,
// in storage or in a send still running, and holds the reload
// (reloadHolds.js). A held move opens the next page in the old code. If the
// deploy removed that page's code, the stale-chunk reload
// (staleChunkReload.js, App.jsx's lazyWithRetry) still runs as it does
// without this gate, held work or not; a follow-up PR makes it obey the holds.
export function PortalUpdateGate({ fallback, children }) {
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  // `origin`: the page the current move started from. A redirect is a
  // replace, as every <Navigate> in the routes is, and it continues that
  // move. So when the move started on a field page, its redirects leave that
  // page too: Today -> /admin -> the dashboard, Today -> /admin/leads ->
  // Pipeline.
  const [gate, setGate] = useState({ pathname, origin: pathname, reloading: false });
  if (gate.pathname !== pathname) {
    const origin = navigationType === 'REPLACE' ? gate.origin : gate.pathname;
    const from = isFieldPath(origin) ? origin : gate.pathname;
    setGate({ pathname, origin, reloading: reloadDueAtMove(pathname, Date.now(), from) });
  }

  useEffect(() => {
    if (!gate.reloading) return undefined;
    let current = true;
    reloadForNewBuild({ current: () => current }).then((blocker) => {
      if (current && blocker) setGate((state) => (state === gate ? { ...state, reloading: false } : state));
    });
    return () => { current = false; };
  }, [gate]);

  return gate.reloading ? fallback : children;
}

const HOLD_TEXT = {
  saving: 'A save is still on its way.',
  request: 'A request is still on its way.',
  'email-draft': 'An email draft or send is still open.',
  'visit-step': 'A visit step is still in progress.',
  'tap-to-pay': 'A Tap to Pay payment is still open.',
  'card-payment': 'A card payment is still going through.',
  dictation: 'Dictation is still turning into text.',
  'text-draft': 'A text draft is not saved in this tab.',
  'estimate-send': 'Send is locked on an estimate in this tab. A reload unlocks it.',
  'schedule-notice': 'A schedule notice is still open.',
  'recap-upload': 'A recap clip is not uploaded yet.',
  'ask-draft': 'An Ask Waves question is not sent yet.',
  'photo-assessment': 'A photo assessment is still being sent.',
  'misting-layout': 'A misting layout is still being saved.',
  'zone-map': 'A treatment zone map is still being saved.',
  'time-clock': 'A time-clock punch is still being sent.',
  'visual-note': 'A visual note is still being saved.',
  'bank-import': 'A bank statement is still being imported.',
  'bank-link': 'A bank connection is still open.',
  'push-setup': 'Push notifications are still being turned on or off.',
  'text-attachment': 'A photo for a text is still being attached.',
  'page-use': 'Anything not saved on this page will be lost.',
  offline: 'This device is offline. A reload may show an error page.',
};

// The Reload bar's button. It obeys the same holds as the automatic reload:
// when work holds it, a click names every held work instead of reloading, and
// the button becomes "Reload anyway". Each click asks again, so "Reload
// anyway" reloads only when nothing holds that the button has not named. A
// new resetKey clears the named work, and so does any use of the page after
// the naming (clearNamed): that use can start new work under a name already
// shown, such as more typing after "Anything not saved on this page will be
// lost.", so the next Reload asks again. `pageUsed`: a use of the page in view
// since it opened (below).
function useHoldAwareReload(resetKey) {
  const [held, setHeld] = useState([]);
  useEffect(() => { setHeld((named) => (named.length ? [] : named)); }, [resetKey]);
  const clearNamed = useCallback(() => setHeld((named) => (named.length ? [] : named)), []);
  const tryReload = (pageUsed) => {
    const blockers = [...reloadBlockers(), ...(pageUsed ? ['page-use'] : [])];
    if (blockers.some((name) => !held.includes(name))) {
      setHeld(blockers);
      return;
    }
    window.location.reload();
  };
  const heldText = [...new Set(held.map((name) => HOLD_TEXT[name] || 'Something in this tab is still open.'))].join(' ');
  return { named: held.length > 0, heldText, tryReload, clearNamed };
}

// A use of the page in view since it opened: a tap, a click, a key or a
// field change anywhere but on this bar. The bar's Reload reloads that page
// in place, and a page keeps unsaved work in many ways: a field, a toggle, a
// picked slot, a signature on a canvas, a shape drawn on a map. No list of
// controls names them all, so after any use the bar asks once first. A page
// move ends the use: the move closes the page and its work. The automatic
// reload waits for a move, so it never needs this. Each use also calls onUse.
function usePageUsed(pathname, onUse) {
  const used = useRef(false);
  useEffect(() => { used.current = false; }, [pathname]);
  useEffect(() => {
    const noteUse = (event) => {
      if (!(event.target instanceof Element) || event.target.closest('[data-portal-update-bar]')) return;
      used.current = true;
      onUse();
    };
    const types = ['pointerdown', 'click', 'keydown', 'input', 'change'];
    types.forEach((type) => document.addEventListener(type, noteUse, true));
    return () => types.forEach((type) => document.removeEventListener(type, noteUse, true));
  }, [onUse]);
  return () => used.current;
}

// Every staff page, Waves Admin and the field pages included: says that a
// newer version is live. A page move or a new build clears the named work.
export function PortalUpdateBar() {
  const { pathname } = useLocation();
  const build = useSyncExternalStore(subscribePortalVersion, newerBuild, () => null);
  const { named, heldText, tryReload, clearNamed } = useHoldAwareReload(`${build} ${pathname}`);
  const pageUsed = usePageUsed(pathname, clearNamed);
  if (!build || !isAdminPath(pathname)) return null;

  return (
    <div role="status" data-portal-update-bar="" style={{ bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))' }}
      className="fixed left-1/2 z-[10990] box-border flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-sm border-hairline border-zinc-300 bg-white px-4 py-2 font-sans text-sm text-zinc-900 shadow-lg">
      <span>{named ? heldText : 'A new version of the portal is ready.'}</span>
      <Button className="min-h-11 shrink-0 text-sm" onClick={() => tryReload(pageUsed())}>
        {named ? 'Reload anyway' : 'Reload'}
      </Button>
    </div>
  );
}
