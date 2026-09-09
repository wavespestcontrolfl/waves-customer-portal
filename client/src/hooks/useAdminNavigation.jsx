import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ADMIN_WORKSPACE_DESTINATIONS, ADMIN_WORKSPACE_GROUP_IDS, getAdminWorkspaceGroups, getAdminWorkspaceSelection } from '../config/adminNavigation';

export const AdminNavigationContext = createContext(null);
const preferenceKey = (accountId) => `waves_admin_navigation:${accountId}`;
const destinationIds = new Set(ADMIN_WORKSPACE_DESTINATIONS.map(({ id }) => id));

function readPreferences(accountId) {
  const defaults = { groups: {}, pins: [] };
  if (!accountId) return defaults;
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(accountId)) || '{}');
    const groups = Object.fromEntries(ADMIN_WORKSPACE_GROUP_IDS
      .filter((id) => typeof saved?.groups?.[id] === 'boolean')
      .map((id) => [id, saved.groups[id]]));
    const pins = Array.isArray(saved?.pins) ? [...new Set(saved.pins)].filter((id) => destinationIds.has(id)).slice(0, 3) : [];
    return { groups, pins };
  } catch { return defaults; }
}

export function AdminNavigationProvider({ user, enabled, agentEstimateEnabled, children }) {
  // The shell keys this provider by the verified account, so neither saved
  // preferences nor a rendered subview can flash from a previous login.
  const location = useLocation();
  const [preferences, setPreferences] = useState(() => readPreferences(user?.id));
  const expanded = preferences.groups;
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
    if (!enabled || !selection.groupId) return;
    setPreferences((current) => ({ ...current, groups: { ...current.groups, [selection.groupId]: true } }));
  }, [enabled, location.key, selection.groupId, selection.itemId]);

  const updatePreferences = (update) => setPreferences((current) => {
    const next = update(current);
    if (user?.id) {
      try { localStorage.setItem(preferenceKey(user.id), JSON.stringify(next)); } catch { /* optional preference */ }
    }
    return next;
  });
  const toggleGroup = (id) => updatePreferences((current) => ({ ...current, groups: { ...current.groups, [id]: !current.groups[id] } }));
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
