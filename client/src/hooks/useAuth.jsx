import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '../utils/api';
import { deactivateNativePushToken, flushNativePushToken, repostNativePushToken } from '../native/nativePush';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [customer, setCustomer] = useState(null);
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const retryTimer = useRef(null);
  // Mirrors `customer` for reads inside the stable loadCustomer callback
  // (empty deps ⇒ stale closure) — the transient branch needs to know
  // whether a session is already on screen.
  const customerRef = useRef(null);

  // Check for existing session on mount
  useEffect(() => {
    const token = localStorage.getItem('waves_token');
    if (token) {
      api.token = token;
      api.refreshToken = localStorage.getItem('waves_refresh_token');
      loadCustomer();
    } else {
      setLoading(false);
    }
    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
    };
  }, []);

  const loadCustomer = useCallback(async (attempt) => {
    // `refreshCustomer` gets used as an event handler, so `attempt` may be
    // anything — only our own retry chain passes a number.
    const n = Number.isFinite(Number(attempt)) ? Number(attempt) : 0;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    try {
      const data = await api.getMe();
      customerRef.current = data;
      setCustomer(data);
      const propertyData = await api.getAuthProperties().catch(() => ({ properties: [] }));
      setProperties(propertyData.properties || []);
      setError(null);
      // Now authenticated — flush any APNs token captured before login (native
      // app only; no-op on web). See native/nativePush.js.
      flushNativePushToken();
    } catch (err) {
      console.error('Failed to load customer:', err);
      // Only a real auth rejection invalidates the session — a network drop
      // or server 5xx on launch must not wipe a valid 30-day login.
      if (err?.status === 401 || err?.status === 403 || err?.sessionExpired) {
        api.clearTokens();
        customerRef.current = null;
        setCustomer(null);
        setProperties([]);
        setLoading(false);
        return;
      }
      // Transient failure: keep the session check PENDING instead of letting
      // a null customer bounce a valid saved session through ProtectedRoute
      // to /login with nothing scheduled to bring it back. An already-loaded
      // session keeps its data; startup stays on the checking screen (which
      // surfaces `error`) and retries with capped backoff.
      setError('Unable to reach the server. Your saved session will resume once you’re back online.');
      // Post-login calls (verifyCode/switchProperty) arrive with loading
      // already false — flip it back so ProtectedRoute holds the checking
      // card during the retry instead of bouncing the valid session to
      // /login. A session already on screen keeps rendering untouched.
      if (!customerRef.current) setLoading(true);
      retryTimer.current = setTimeout(
        () => { loadCustomer(n + 1); },
        Math.min(30000, 2000 * 2 ** Math.min(n, 4)),
      );
      return;
    }
    setLoading(false);
  }, []);

  const sendCode = async (phone) => {
    setError(null);
    try {
      await api.sendCode(phone);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  const verifyCode = async (phone, code) => {
    setError(null);
    try {
      const data = await api.verifyCode(phone, code);
      api.setTokens(data.token, data.refreshToken);
      setProperties(data.properties || []);
      await loadCustomer();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  const logout = async () => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    // Deactivate this device's push registration BEFORE dropping the JWT —
    // otherwise the device keeps receiving the previous account's pushes.
    // Awaited (with a cap) because the unsubscribe may need the api client's
    // 401→refresh retry, which dies the moment clearTokens runs; the timeout
    // keeps a dead network from wedging logout. No-op (instant) on web.
    try {
      await Promise.race([
        deactivateNativePushToken(),
        new Promise((resolve) => { setTimeout(resolve, 4000); }),
      ]);
    } catch { /* best-effort */ }
    api.clearTokens();
    customerRef.current = null;
    setCustomer(null);
    setProperties([]);
  };

  const switchProperty = async (customerId) => {
    setError(null);
    try {
      const data = await api.selectAuthProperty(customerId);
      api.setTokens(data.token, data.refreshToken);
      // Re-point this device's push subscription at the newly selected
      // customer — otherwise pushes keep flowing to the previous property.
      repostNativePushToken();
      // The token now points at the TARGET property — the old customer must
      // not keep rendering (and firing actions) against it if the reload
      // hits a transient failure. Go pending until the target customer
      // loads; loadCustomer's retry branch keeps it pending on failure.
      customerRef.current = null;
      setLoading(true);
      setProperties(data.properties || []);
      await loadCustomer();
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    }
  };

  return (
    <AuthContext.Provider value={{
      customer,
      properties,
      loading,
      error,
      isAuthenticated: !!customer,
      sendCode,
      verifyCode,
      switchProperty,
      logout,
      refreshCustomer: loadCustomer,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
