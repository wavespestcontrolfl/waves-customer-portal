import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useBiometricLock } from '../components/BiometricGate';
import { isNativeApp } from '../native/platform';

const PortalReadContext = createContext(null);
export const READ_TIMEOUT_MS = 15000;
const RESUME_REFRESH_MS = 1000;

// Scoped to the mounted, authenticated property. Nothing is written to browser
// storage: logout, a different session, or a property change drops these reads.
export function PortalReadProvider({ enabled, children }) {
  const cache = useRef(new Map()).current;
  const readers = useRef(new Set()).current;
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const refreshQueued = useRef(false);
  const lastRefresh = useRef(Date.now());
  const locked = useBiometricLock();
  const lockedRef = useRef(locked);
  lockedRef.current = locked;

  const register = useCallback((read) => {
    readers.add(read);
    return () => readers.delete(read);
  }, [readers]);

  const refresh = useCallback(async ({ preserveVerified = true } = {}) => {
    if (!enabled || refreshingRef.current || lockedRef.current || navigator.onLine === false) return;
    refreshingRef.current = true;
    lastRefresh.current = Date.now();
    setRefreshing(true);
    try {
      do {
        refreshQueued.current = false;
        await Promise.allSettled([...readers].map(read => read({ preserveVerified })));
      } while (refreshQueued.current && !lockedRef.current && navigator.onLine !== false);
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [enabled, readers]);

  useEffect(() => {
    if (!enabled) return undefined;
    const resume = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh.current >= RESUME_REFRESH_MS) void refresh();
    };
    const reconnect = () => {
      setOnline(true);
      refreshQueued.current = refreshingRef.current;
      void refresh();
    };
    const disconnect = () => setOnline(false);
    window.addEventListener('online', reconnect);
    window.addEventListener('offline', disconnect);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    const restore = (event) => { if (event.persisted) resume(); };
    window.addEventListener('pageshow', restore);
    let disposed = false;
    let nativeListener;
    if (isNativeApp()) {
      import('@capacitor/app')
        .then(({ App }) => App.addListener('appStateChange', ({ isActive }) => {
          if (!disposed && isActive) resume();
        }))
        .then((listener) => {
          if (disposed) void listener.remove().catch(() => {});
          else nativeListener = listener;
        })
        .catch(() => {}); // Browser lifecycle and post-unlock refresh remain available.
    }
    return () => {
      disposed = true;
      window.removeEventListener('online', reconnect);
      window.removeEventListener('offline', disconnect);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('pageshow', restore);
      if (nativeListener) void nativeListener.remove().catch(() => {});
    };
  }, [enabled, refresh]);

  const wasLocked = useRef(locked);
  useEffect(() => {
    if (wasLocked.current && !locked) {
      refreshQueued.current = refreshingRef.current;
      void refresh();
    }
    wasLocked.current = locked;
  }, [locked, refresh]);

  const value = useMemo(() => ({ enabled, cache, register, online, refreshing, refresh }),
    [enabled, cache, register, online, refreshing, refresh]);
  return <PortalReadContext.Provider value={value}>{children}</PortalReadContext.Provider>;
}

export function usePortalRefresh() {
  return useContext(PortalReadContext);
}

// Used only for the portal's read-only visit/document data. Cached results never
// stand in for auth, permission checks, writes, or success acknowledgments.
export default function usePortalRead(key, load) {
  const portal = usePortalRefresh();
  const cache = portal?.enabled ? portal.cache : null;
  const register = portal?.enabled ? portal.register : null;
  const offline = portal?.enabled && !portal.online;
  const loadRef = useRef(load);
  loadRef.current = load;
  const sequence = useRef(0);
  const [state, setState] = useState(() => ({
    data: cache?.get(key)?.data,
    updatedAt: cache?.get(key)?.updatedAt || null,
    loading: !cache?.has(key),
    pending: false,
    verified: false,
    error: '',
  }));
  useEffect(() => {
    if (offline) setState(previous => ({ ...previous, verified: false }));
  }, [offline]);

  const refresh = useCallback(async ({ preserveVerified = false } = {}) => {
    const attempt = ++sequence.current;
    // Background reads preserve a healthy view so they do not collapse scroll
    // or remove focused inputs. Manual retries, offline/error/remounted-cache
    // states remain unverified until success; 401/403 still clear cache below.
    setState(previous => ({
      ...previous,
      loading: previous.data === undefined,
      pending: true,
      verified: preserveVerified ? previous.verified : false,
      error: previous.data === undefined ? '' : previous.error,
    }));
    let timer;
    try {
      if (cache && navigator.onLine === false) throw new Error('You are offline. Reconnect to update this information.');
      const data = await Promise.race([
        loadRef.current(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The connection is taking too long. Please try again.')), READ_TIMEOUT_MS); }),
      ]);
      if (sequence.current !== attempt) return;
      const next = { data, updatedAt: Date.now(), loading: false, pending: false, verified: navigator.onLine !== false, error: '' };
      cache?.set(key, next);
      setState(next);
    } catch (error) {
      if (sequence.current !== attempt) return;
      // An explicit access denial must not leave cached customer details behind.
      const denied = error?.status === 401 || error?.status === 403 || error?.sessionExpired;
      if (denied) cache?.clear();
      setState(previous => ({
        ...previous,
        ...(denied ? { data: undefined, updatedAt: null } : {}),
        loading: false,
        pending: false,
        verified: false,
        error: error?.message || 'Could not update this information.',
      }));
    } finally {
      clearTimeout(timer);
    }
  }, [cache, key]);

  useEffect(() => {
    void refresh();
    return () => { sequence.current += 1; };
  }, [refresh]);
  useEffect(() => register?.(refresh), [register, refresh]);

  const update = useCallback((change) => {
    sequence.current += 1;
    setState(previous => {
      if (previous.data === undefined) return previous;
      const next = { ...previous, data: change(previous.data), error: '', loading: false, pending: false, verified: navigator.onLine !== false, updatedAt: Date.now() };
      cache?.set(key, next);
      return next;
    });
  }, [cache, key]);

  return { ...state, refresh, update, saved: Boolean(cache && state.data !== undefined && (offline || state.error || !state.verified)), offline };
}
