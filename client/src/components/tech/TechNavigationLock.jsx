import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';

const NavigationLock = createContext(null);

function HistoryGuard({ lockedIndex }) {
  useLayoutEffect(() => {
    const guardHistory = (event) => {
      const current = lockedIndex.current;
      const next = event.state?.idx;
      if (!Number.isInteger(current) || !Number.isInteger(next) || current === next) return;
      event.stopImmediatePropagation();
      window.history.go(current - next);
    };
    window.addEventListener('popstate', guardHistory);
    return () => window.removeEventListener('popstate', guardHistory);
  }, [lockedIndex]);
  return null;
}

// The guard mounts BEFORE BrowserRouter's history listener. Window POP
// listeners run in registration order in Chromium, even with capture=true.
// Registering only after staff verification allows the route to unmount first.
export default function TechNavigationLock({ children }) {
  const [navigationBusy, setNavigationBusy] = useState(false);
  const lockedIndex = useRef(null);
  useLayoutEffect(() => {
    lockedIndex.current = navigationBusy ? window.history.state?.idx : null;
  }, [navigationBusy]);
  return <NavigationLock.Provider value={{ navigationBusy, setNavigationBusy }}>
    <HistoryGuard lockedIndex={lockedIndex} />
    {children}
  </NavigationLock.Provider>;
}

export function useTechNavigationLock() { return useContext(NavigationLock); }
