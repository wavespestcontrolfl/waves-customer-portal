import { createContext, useContext, useEffect, useRef } from 'react';

const PageDataContext = createContext(null);

export function IntelligenceBarPageDataProvider({ children }) {
  const pageData = useRef(null);
  return <PageDataContext.Provider value={pageData}>{children}</PageDataContext.Provider>;
}

// Only identifiers and the viewed date belong here, never cached customer facts.
export function usePublishIntelligenceBarPageData({ customer_id = null, appointment_id = null, viewed_date = null }) {
  const ref = useContext(PageDataContext);
  useEffect(() => {
    if (!ref) return undefined;
    const value = { customer_id, appointment_id, viewed_date };
    ref.current = value;
    return () => { if (ref.current === value) ref.current = null; };
  }, [ref, customer_id, appointment_id, viewed_date]);
}

export function useIntelligenceBarPageData() {
  return useContext(PageDataContext);
}
