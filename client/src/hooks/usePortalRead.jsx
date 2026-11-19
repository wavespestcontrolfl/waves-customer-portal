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
  const invalidationReaders = useRef(new Map()).current;
  const invalidationEpoch = useRef(0);
  const keyInvalidationEpochs = useRef(new Map()).current;
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

  const getInvalidationEpoch = useCallback((key) => ({
    all: invalidationEpoch.current,
    key: keyInvalidationEpochs.get(key) || 0,
  }), [keyInvalidationEpochs]);

  const invalidationEpochIsCurrent = useCallback((key, expected) => (
    invalidationEpoch.current === expected?.all
    && (keyInvalidationEpochs.get(key) || 0) === expected?.key
  ), [keyInvalidationEpochs]);

  const registerInvalidation = useCallback((key, expectedEpoch, invalidate) => {
    const keyedReaders = invalidationReaders.get(key) || new Set();
    if (!invalidationReaders.has(key)) invalidationReaders.set(key, keyedReaders);
    keyedReaders.add(invalidate);
    // An old denial can settle after render but before this effect subscribes.
    // Reconcile that gap before the reader can keep showing its render-time cache.
    if (!invalidationEpochIsCurrent(key, expectedEpoch)) invalidate();
    return () => {
      keyedReaders.delete(invalidate);
      if (keyedReaders.size === 0) invalidationReaders.delete(key);
    };
  }, [invalidationEpochIsCurrent, invalidationReaders]);

  const evict = useCallback(({ key, clearAll = false, message } = {}) => {
    let targets;
    if (clearAll) {
      cache.clear();
      invalidationEpoch.current += 1;
      targets = [...invalidationReaders.values()].flatMap(keyedReaders => [...keyedReaders]);
    } else {
      cache.delete(key);
      keyInvalidationEpochs.set(key, (keyInvalidationEpochs.get(key) || 0) + 1);
      targets = [...(invalidationReaders.get(key) || [])];
    }
    // Snapshot before notifying because an invalidation may synchronously
    // unmount a reader and mutate the registration map.
    targets.forEach(invalidate => invalidate(message));
  }, [cache, invalidationReaders, keyInvalidationEpochs]);

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
      if (document.visibilityState === 'visible' && Date.now() - lastRefresh.current >= RESUME_REFRESH_MS) {
        refreshQueued.current = refreshingRef.current;
        void refresh();
      }
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

  const value = useMemo(() => ({
    enabled,
    cache,
    evict,
    getInvalidationEpoch,
    invalidationEpochIsCurrent,
    register,
    registerInvalidation,
    online,
    refreshing,
    refresh,
  }), [
    enabled, cache, evict, getInvalidationEpoch, invalidationEpochIsCurrent,
    register, registerInvalidation, online, refreshing, refresh,
  ]);
  return <PortalReadContext.Provider value={value}>{children}</PortalReadContext.Provider>;
}

export function usePortalRefresh() {
  return useContext(PortalReadContext);
}

function portalReadAuthorizationDenied(error) {
  return error?.status === 401 || error?.status === 403 || error?.sessionExpired;
}

// Used only for the portal's read-only visit/document data. Cached results never
// stand in for auth, permission checks, writes, or success acknowledgments.
export default function usePortalRead(key, load) {
  const portal = usePortalRefresh();
  const {
    cache = null,
    evict: providerEvict = null,
    getInvalidationEpoch = null,
    invalidationEpochIsCurrent = null,
    register = null,
    registerInvalidation = null,
  } = portal?.enabled ? portal : {};
  const offline = portal?.enabled && !portal.online;
  const loadRef = useRef(load);
  loadRef.current = load;
  const sequence = useRef(0);
  const renderedEpoch = useRef(null);
  if (renderedEpoch.current?.key !== key || renderedEpoch.current?.source !== getInvalidationEpoch) {
    renderedEpoch.current = { key, source: getInvalidationEpoch, value: getInvalidationEpoch?.(key) };
  }
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

  const invalidateLocal = useCallback((message = 'Could not update this information.') => {
    sequence.current += 1;
    setState({
      data: undefined,
      updatedAt: null,
      loading: false,
      pending: false,
      verified: false,
      error: message,
    });
  }, []);

  const refresh = useCallback(async ({ preserveVerified = false } = {}) => {
    const attempt = ++sequence.current;
    const attemptEpoch = getInvalidationEpoch?.(key);
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
    let timedOut = false;
    const clearDeniedRead = (error) => {
      const denied = portalReadAuthorizationDenied(error);
      if (denied) {
        if (providerEvict) providerEvict({ clearAll: true, message: error?.message });
        else cache?.clear();
      }
      return denied;
    };
    try {
      if (cache && navigator.onLine === false) throw new Error('You are offline. Reconnect to update this information.');
      const loadPromise = Promise.resolve(loadRef.current({ isCurrent: () => sequence.current === attempt }));
      // Promise.race stops forwarding once the timeout wins. Observe the
      // underlying request as well so a later explicit denial still purges
      // shared customer data before an offline remount can recover it.
      void loadPromise.catch(error => {
        // Rejections before the timeout continue through the ordinary catch
        // below. This observer owns only a rejection that arrives after the
        // race has already settled, avoiding duplicate state transitions.
        if (!timedOut || !clearDeniedRead(error)) return;
        if (sequence.current === attempt) {
          setState(previous => ({
            ...previous,
            data: undefined,
            updatedAt: null,
            loading: false,
            pending: false,
            verified: false,
            error: error?.message || 'Could not update this information.',
          }));
        }
      });
      const data = await Promise.race([
        loadPromise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('The connection is taking too long. Please try again.'));
          }, READ_TIMEOUT_MS);
        }),
      ]);
      if (sequence.current !== attempt || (invalidationEpochIsCurrent && !invalidationEpochIsCurrent(key, attemptEpoch))) return;
      const next = { data, updatedAt: Date.now(), loading: false, pending: false, verified: navigator.onLine !== false, error: '' };
      cache?.set(key, next);
      setState(next);
    } catch (error) {
      // An explicit access denial must not leave cached customer details behind.
      const denied = clearDeniedRead(error);
      // Auth/session denial is provider-wide and remains authoritative even
      // when this reader unmounted while the request was in flight. Local UI
      // state is still guarded by the sequence below, but the shared cache
      // must not resurrect revoked details on an offline remount.
      if (sequence.current !== attempt) return;
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
  }, [cache, getInvalidationEpoch, invalidationEpochIsCurrent, key, providerEvict]);

  useEffect(() => registerInvalidation?.(
    key,
    renderedEpoch.current?.value,
    invalidateLocal,
  ), [invalidateLocal, key, registerInvalidation]);

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

  const invalidate = useCallback((message = 'Could not update this information.', { clearAll = false } = {}) => {
    // Scope/auth conflicts are stronger than an ordinary failed refresh: the
    // last verified payload is no longer safe to display or remount from the
    // provider cache. Advancing the sequence also denies every in-flight
    // completion that started before the invalidation.
    if (providerEvict) providerEvict({ key, clearAll, message });
    else {
      if (clearAll) cache?.clear();
      else cache?.delete(key);
      invalidateLocal(message);
    }
  }, [cache, invalidateLocal, key, providerEvict]);

  const evict = useCallback(({ clearAll = false, message } = {}) => {
    // Direct pagination reads do not flow through refresh's catch, and may
    // finish after their reader unmounts. The provider notifies any remaining
    // mounted readers while the dead caller only retains this stable function.
    if (providerEvict) providerEvict({ key, clearAll, message });
    else if (clearAll) cache?.clear();
    else cache?.delete(key);
  }, [cache, key, providerEvict]);

  const cacheEntryGuard = useCallback(() => {
    const expected = cache?.get(key);
    return () => cache?.get(key) === expected;
  }, [cache, key]);

  const freshnessGuard = useCallback(() => {
    const expected = sequence.current;
    return () => sequence.current === expected;
  }, []);

  return { ...state, refresh, update, invalidate, evict, cacheEntryGuard, freshnessGuard, saved: Boolean(cache && state.data !== undefined && (offline || state.error || !state.verified)), offline };
}
