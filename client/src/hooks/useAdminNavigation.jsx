import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { ADMIN_WORKSPACE_GROUP_IDS, getAdminWorkspaceGroups, getAdminWorkspaceSelection } from '../config/adminNavigation';

export const AdminNavigationContext = createContext(null);
const preferenceKey = (accountId) => `waves_admin_navigation:${accountId}`;

function readGroups(accountId) {
  if (!accountId) return {};
  try {
    const saved = JSON.parse(localStorage.getItem(preferenceKey(accountId)) || '{}');
    return Object.fromEntries(ADMIN_WORKSPACE_GROUP_IDS
      .filter((id) => typeof saved?.groups?.[id] === 'boolean')
      .map((id) => [id, saved.groups[id]]));
  } catch { return {}; }
}

export function AdminNavigationProvider({ user, enabled, agentEstimateEnabled, children }) {
  // The shell keys this provider by the verified account, so neither saved
  // preferences nor a rendered subview can flash from a previous login.
  const location = useLocation();
  const [expanded, setExpanded] = useState(() => readGroups(user?.id));
  const [renderedView, setRenderedView] = useState(null);
  const groups = useMemo(() => getAdminWorkspaceGroups(user?.role, { agent_estimate: agentEstimateEnabled }), [user?.role, agentEstimateEnabled]);
  const publishView = useCallback((pathname, tab) => {
    const view = { pathname, tab, routeKey: location.key };
    setRenderedView(view);
    return () => setRenderedView((current) => current === view ? null : current);
  }, [location.key]);
  const selection = getAdminWorkspaceSelection(location, renderedView?.routeKey === location.key ? renderedView : null);

  useEffect(() => {
    if (!enabled || !selection.groupId) return;
    setExpanded((current) => ({ ...current, [selection.groupId]: true }));
  }, [enabled, location.key, selection.groupId, selection.itemId]);

  const toggleGroup = (id) => setExpanded((current) => {
    const next = { ...current, [id]: !current[id] };
    if (user?.id) {
      try { localStorage.setItem(preferenceKey(user.id), JSON.stringify({ groups: next })); } catch { /* optional preference */ }
    }
    return next;
  });

  return <AdminNavigationContext.Provider value={enabled ? { groups, expanded, toggleGroup, selection, publishView } : null}>
    {children}
  </AdminNavigationContext.Provider>;
}

export default function useAdminNavigation() {
  return useContext(AdminNavigationContext);
}
