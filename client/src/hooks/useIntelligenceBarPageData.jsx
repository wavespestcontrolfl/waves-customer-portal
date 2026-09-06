import { createContext, useContext, useEffect, useMemo, useState } from 'react';

const PageDataContext = createContext(null);

export function IntelligenceBarPageDataProvider({ children }) {
  const [pageData, setPageData] = useState(null);
  const value = useMemo(() => ({ pageData, setPageData }), [pageData]);
  return <PageDataContext.Provider value={value}>{children}</PageDataContext.Provider>;
}

// Only identifiers and the viewed date belong here, never cached customer facts.
export function usePublishIntelligenceBarPageData({ customer_id = null, appointment_id = null, viewed_date = null }) {
  const setPageData = useContext(PageDataContext)?.setPageData;
  useEffect(() => {
    if (!setPageData) return undefined;
    const value = { customer_id, appointment_id, viewed_date };
    setPageData(value);
    return () => setPageData(current => current === value ? null : current);
  }, [setPageData, customer_id, appointment_id, viewed_date]);
}

export function useIntelligenceBarPageData() {
  return useContext(PageDataContext)?.pageData;
}
