import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { adminNavigationPreferenceKey as preferenceKey, warmFieldViewLanding } from '../lib/fieldView';
import { ADMIN_WORKSPACE_DESTINATIONS, ADMIN_WORKSPACE_GROUP_IDS, getAdminWorkspaceGroups, getAdminWorkspaceSelection } from '../config/adminNavigation';

export const AdminNavigationContext = createContext(null);
// Version 1 also saved every group the menu opened for the page on screen, so
// after a few days of use every group was open. Groups saved before version 2
// are dropped once; pins carry over.
const PREFERENCE_VERSION = 2;
const destinationIds = new Set(ADMIN_WORKSPACE_DESTINATIONS.map(({ id }) => id));

// This account's saved menu settings on this phone, or null when storage
// cannot be read. Field view is not a menu group, so a version change never
// drops it.
function readSavedPreferences(accountId) {
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(accountId)) || '{}');
    const groups = saved?.version !== PREFERENCE_VERSION ? {} : Object.fromEntries(ADMIN_WORKSPACE_GROUP_IDS
      .filter((id) => typeof saved?.groups?.[id] === 'boolean')
      .map((id) => [id, saved.groups[id]]));
    const pins = Array.isArray(saved?.pins) ? [...new Set(saved.pins)].filter((id) => destinationIds.has(id)).slice(0, 3) : [];
    return { groups, pins, fieldView: saved?.fieldView === true };
  } catch { return null; }
}

function readPreferences(accountId) {
  return (accountId && readSavedPreferences(accountId)) || { groups: {}, pins: [], fieldView: false };
}

export function AdminNavigationProvider({ user, enabled, agentEstimateEnabled, children }) {
  // The shell keys this provider by the verified account, so neither saved
  // preferences nor a rendered subview can flash from a previous login.
  const location = useLocation();
  const [preferences, setPreferences] = useState(() => readPreferences(user?.id));
  // The group of the page on screen opens by itself. That opening is never
  // saved: it ends when navigation leaves the group, and a collapse by hand
  // holds until navigation changes. Only groups opened or closed by hand are saved.
  const [autoOpen, setAutoOpen] = useState(null);
  const expanded = useMemo(
    () => (autoOpen ? { ...preferences.groups, [autoOpen]: true } : preferences.groups),
    [autoOpen, preferences.groups],
  );
  const [renderedView, setRenderedView] = useState(null);
  const groups = useMemo(() => getAdminWorkspaceGroups(user?.role, { agent_estimate: agentEstimateEnabled }), [user?.role, agentEstimateEnabled]);
  const items = groups.flatMap((group) => group.items);
  const pinnedItems = preferences.pins.map((id) => items.find((item) => item.id === id)).filter(Boolean);
  const publishView = useCallback((pathname, tab) => {
    const view = { pathname, tab, routeKey: location.key };
    setRenderedView(view);
    return () => setRenderedView((current) => current === view ? null : current);
  }, [location.key]);
  const selection = getAdminWorkspaceSelection(location, renderedView?.routeKey === location.key ? renderedView : null);

  useEffect(() => {
    if (!enabled) return;
    setAutoOpen(selection.groupId);
  }, [enabled, location.key, selection.groupId, selection.itemId]);

  // Every tab on this phone saves to the same record. A change applies to the
  // newest saved settings (this tab's own when storage cannot be read), so a
  // tab that missed another tab's change never writes an old value back. A
  // write can fail while reads still work (full storage). A pin or group
  // change then stays in this tab as the base for the next change, until a
  // write succeeds or another tab's save arrives. The Field view switch never
  // changes unsaved (onlyIfSaved): the shell remounts on every page change
  // and a cold open reads storage, so an unsaved switch would turn itself
  // off. The read and the write stay outside the state update: StrictMode
  // runs a queued update twice in development, and a second pin toggle would
  // undo the first. Returns true when the change reached storage.
  const unsaved = useRef(null);
  const updatePreferences = (update, { onlyIfSaved = false } = {}) => {
    const next = update(unsaved.current || (user?.id && readSavedPreferences(user.id)) || preferences);
    let saved = false;
    if (user?.id) {
      try {
        localStorage.setItem(preferenceKey(user.id), JSON.stringify({ ...next, version: PREFERENCE_VERSION }));
        saved = true;
      } catch { /* full or blocked storage */ }
    }
    if (!saved && onlyIfSaved) return false;
    unsaved.current = saved ? null : next;
    setPreferences(next);
    return saved;
  };
  // Another tab's save shows here at once: pins, groups and the switch the
  // tabs and the /admin landing read. It is newer than anything this tab
  // could not save. A cleared storage reads as nothing saved.
  useEffect(() => {
    if (!user?.id) return undefined;
    const key = preferenceKey(user.id);
    const onStorage = (event) => {
      if (event.key !== null && event.key !== key) return;
      unsaved.current = null;
      setPreferences(readPreferences(user.id));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [user?.id]);
  const toggleGroup = (id) => {
    const open = Boolean(expanded[id]);
    if (open && id === autoOpen) setAutoOpen(null);
    updatePreferences((current) => ({ ...current, groups: { ...current.groups, [id]: !open } }));
  };
  const togglePin = (id) => updatePreferences((current) => {
    if (!items.some((item) => item.id === id)) return current;
    const visiblePins = current.pins.filter((pin) => items.some((item) => item.id === pin));
    if (visiblePins.includes(id)) return { ...current, pins: visiblePins.filter((pin) => pin !== id) };
    return visiblePins.length < 3 ? { ...current, pins: [...visiblePins, id] } : current;
  });

  // Only an admin login has Field view; any other role never sees it applied.
  // The switch moves only when this phone saved it; false tells the Settings
  // row the save failed, so the row can say why the switch did not move.
  const fieldView = user?.role === 'admin' && preferences.fieldView === true;
  const setFieldView = (on) => updatePreferences((current) => ({ ...current, fieldView: on === true }), { onlyIfSaved: true });
  // A verified session with the switch on readies Today too: after a deploy
  // the app can open on another page (a push tap), and the next open with no
  // signal still lands on Today. Each mount reuses the page's try (see
  // warmFieldViewLanding). The signal returning tries anew, as does a worker
  // that takes control of the page: the app registers it after the page
  // loads, and a new worker may hold other storage.
  useEffect(() => {
    if (!enabled || !fieldView) return undefined;
    const warm = () => { void warmFieldViewLanding(); };
    const warmAgain = () => { void warmFieldViewLanding({ again: true }); };
    const worker = typeof navigator === 'undefined' ? null : navigator.serviceWorker;
    warm();
    window.addEventListener('online', warmAgain);
    worker?.addEventListener?.('controllerchange', warmAgain);
    return () => {
      window.removeEventListener('online', warmAgain);
      worker?.removeEventListener?.('controllerchange', warmAgain);
    };
  }, [enabled, fieldView]);

  return <AdminNavigationContext.Provider value={enabled ? { groups, expanded, toggleGroup, selection, publishView, pinnedItems, togglePin, fieldView, setFieldView } : null}>
    {children}
  </AdminNavigationContext.Provider>;
}

export default function useAdminNavigation() {
  return useContext(AdminNavigationContext);
}
