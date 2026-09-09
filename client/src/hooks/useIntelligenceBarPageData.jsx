import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

const PageDataContext = createContext(null);

export function IntelligenceBarPageDataProvider({ children, open = null }) {
  const [scopes, setScopes] = useState([]);
  const [lastMutation, notifyMutation] = useState(null);
  const value = useMemo(() => ({ pageData: (scopes.filter(scope => scope.overlay).at(-1) || scopes.at(-1))?.data || null,
    setScopes, open, lastMutation, notifyMutation }), [scopes, open, lastMutation]);
  return <PageDataContext.Provider value={value}>{children}</PageDataContext.Provider>;
}

// Only identifiers and the viewed date belong here, never cached customer facts.
export function usePublishIntelligenceBarPageData({ customer_id = null, appointment_id = null, viewed_date = null, overlay = false }) {
  const setScopes = useContext(PageDataContext)?.setScopes;
  const owner = useRef({});
  useEffect(() => {
    if (!setScopes) return undefined;
    const scope = { owner: owner.current, overlay, data: { customer_id, appointment_id, viewed_date } };
    setScopes(current => [...current.filter(item => item.owner !== scope.owner), scope]);
    // Closing a record overlay restores the still-mounted page context. A
    // departed page is removed, so stale identifiers cannot be resurrected.
    return () => setScopes(current => current.filter(item => item.owner !== scope.owner));
  }, [setScopes, customer_id, appointment_id, viewed_date, overlay]);
}

export function useIntelligenceBarPageData() {
  return useContext(PageDataContext)?.pageData;
}

// Record overlays share the shell opener and refresh only a matching saved
// result. These client notifications trigger reads, never authorize writes.
export function useIntelligenceBarActions() {
  return useContext(PageDataContext) || {};
}
