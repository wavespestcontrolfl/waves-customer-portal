import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ADMIN_WORKSPACE_DESTINATIONS, ADMIN_WORKSPACE_GROUP_IDS, getAdminWorkspaceGroups, getAdminWorkspaceSelection } from '../config/adminNavigation';

export const AdminNavigationContext = createContext(null);
const preferenceKey = (accountId) => `waves_admin_navigation:${accountId}`;
// Version 1 also saved every group the menu opened for the page on screen, so
// after a few days of use every group was open. Groups saved before version 2
// are dropped once; pins carry over.
const PREFERENCE_VERSION = 2;
const destinationIds = new Set(ADMIN_WORKSPACE_DESTINATIONS.map(({ id }) => id));

function readPreferences(accountId) {
  const defaults = { groups: {}, pins: [] };
  if (!accountId) return defaults;
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(accountId)) || '{}');
    const groups = saved?.version !== PREFERENCE_VERSION ? {} : Object.fromEntries(ADMIN_WORKSPACE_GROUP_IDS
      .filter((id) => typeof saved?.groups?.[id] === 'boolean')
      .map((id) => [id, saved.groups[id]]));
    const pins = Array.isArray(saved?.pins) ? [...new Set(saved.pins)].filter((id) => destinationIds.has(id)).slice(0, 3) : [];
    return { groups, pins };
  } catch { return defaults; }
}

export function AdminNavigationProvider({ user, enabled, agentEstimateEnabled, bidDeskEnabled = false, bidKitEnabled = false, children }) {
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
  const groups = useMemo(() => getAdminWorkspaceGroups(user?.role, { agent_estimate: agentEstimateEnabled, bid_desk: bidDeskEnabled, bid_kit: bidKitEnabled }), [user?.role, agentEstimateEnabled, bidDeskEnabled, bidKitEnabled]);
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

  const updatePreferences = (update) => setPreferences((current) => {
    const next = update(current);
    if (user?.id) {
      try { localStorage.setItem(preferenceKey(user.id), JSON.stringify({ ...next, version: PREFERENCE_VERSION })); } catch { /* optional preference */ }
    }
    return next;
  });
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

  return <AdminNavigationContext.Provider value={enabled ? { groups, expanded, toggleGroup, selection, publishView, pinnedItems, togglePin } : null}>
    {children}
  </AdminNavigationContext.Provider>;
}

export default function useAdminNavigation() {
  return useContext(AdminNavigationContext);
}
