import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from './ui';
import { isAdminPath } from '../lib/adminBookmarkMeta';
import { newerBuild, subscribePortalVersion } from '../lib/portalVersion';
import { reloadBlocker, reloadDueAtMove, reloadForNewBuild } from '../lib/portalReload';

// Wraps the route tree (App.jsx). At a page move that is due a reload
// (lib/portalReload.js) it shows `fallback` in place of the routes, so the old
// page closes and the new one does not start, then reloads. When something
// holds the reload, the routes come back and the Reload bar stays. The first
// page this tab loaded never reloads. The fallback drops nothing a move keeps:
// App.jsx's RoutesErrorBoundary keys the route tree on the pathname, so every
// page move already remounts the staff layout and all it holds in React state
// (the Ask Waves prompt included). Work that outlives a move is in a module
// or in storage, and registers a hold (reloadHolds.js).
export function PortalUpdateGate({ fallback, children }) {
  const { pathname } = useLocation();
  const [gate, setGate] = useState({ pathname, reloading: false });
  if (gate.pathname !== pathname) setGate({ pathname, reloading: reloadDueAtMove(pathname) });

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
  'email-draft': 'An email draft or send is still open.',
  'visit-step': 'A visit step is still in progress.',
  'tap-to-pay': 'A Tap to Pay payment is still open.',
  dictation: 'Dictation is still turning into text.',
  'text-draft': 'A text draft is not saved in this tab.',
  'estimate-send': 'Send is locked on an estimate in this tab. A reload unlocks it.',
  'schedule-notice': 'A schedule notice is still open.',
};

// Every staff page, Waves Admin and the field pages included: says that a
// newer version is live. Its button obeys the same holds as the automatic
// reload; when one holds, the bar names it and offers "Reload anyway". Each
// click asks again, so "Reload anyway" only reloads past the work it named,
// and a page move or a new build clears the named work.
export function PortalUpdateBar() {
  const { pathname } = useLocation();
  const build = useSyncExternalStore(subscribePortalVersion, newerBuild, () => null);
  const [held, setHeld] = useState(null);
  useEffect(() => { setHeld(null); }, [build, pathname]);
  if (!build || !isAdminPath(pathname)) return null;

  const tryReload = () => {
    const blocker = reloadBlocker();
    if (blocker && blocker !== held) setHeld(blocker);
    else window.location.reload();
  };
  return (
    <div role="status" style={{ bottom: 'calc(80px + env(safe-area-inset-bottom, 0px))' }}
      className="fixed left-1/2 z-[10990] box-border flex w-max max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-sm border-hairline border-zinc-300 bg-white px-4 py-2 font-sans text-sm text-zinc-900 shadow-lg">
      <span>{held ? (HOLD_TEXT[held] || 'Something in this tab is still open.') : 'A new version of the portal is ready.'}</span>
      <Button className="min-h-11 shrink-0 text-sm" onClick={tryReload}>
        {held ? 'Reload anyway' : 'Reload'}
      </Button>
    </div>
  );
}
