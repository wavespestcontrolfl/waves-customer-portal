import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '../utils/api';
import { deactivateNativePushToken, flushNativePushToken, repostNativePushToken } from '../native/nativePush';

const AuthContext = createContext(null);

// Server auth routes send intentional customer copy in the JSON `error`
// field ("Invalid code", rate-limit sentences) — show those verbatim. But
// api.js also throws raw non-JSON bodies (proxy HTML error pages) and
// "Request failed (502)" fallbacks, which are not customer copy (F-059).
// Customer identity baked into a session JWT ({ customerId } payload, see
// server/middleware/auth.js). Lets the cross-tab storage handler tell an
// identity change (login / property switch elsewhere) apart from a routine
// refresh of the SAME customer's token — api.js persists refreshed tokens to
// localStorage too, and those must not blank a working tab. Null (missing /
// undecodable token) is treated by the caller as an identity change.
function tokenCustomerId(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
    return payload.customerId ?? null;
  } catch {
    return null;
  }
}

function authErrorCopy(err) {
  const msg = String(err?.message || '').trim();
  const looksCurated = msg
    && msg.length <= 140
    && !/[<>]/.test(msg)
    && !/^Request failed \(/i.test(msg)
    && !/^HTTP\s*\d{3}/i.test(msg);
  if (looksCurated) return msg;
  if (err?.status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  return 'Something went wrong. Please try again in a moment.';
}

export function AuthProvider({ children }) {
  const [customer, setCustomer] = useState(null);
  const [properties, setProperties] = useState([]);
  const [propertiesError, setPropertiesError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const retryTimer = useRef(null);
  const logoutTokenReleaseRef = useRef(null);
  // Mirrors `customer` for reads inside the stable loadCustomer callback
  // (empty deps ⇒ stale closure) — the transient branch needs to know
  // whether a session is already on screen.
  const customerRef = useRef(null);

  // Check for existing session on mount
  useEffect(() => {
    const token = localStorage.getItem('waves_token');
    if (token) {
      api.adoptTokens(token, localStorage.getItem('waves_refresh_token'));
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
      try {
        const propertyData = await api.getAuthProperties();
        setProperties(propertyData.properties || []);
        setPropertiesError(null);
      } catch (propertyErr) {
        // The active customer is still valid. Preserve any property list we
        // already have instead of collapsing a multi-property account to a
        // single property, and surface a retry in the account menu.
        console.error('Failed to load service properties:', propertyErr);
        setPropertiesError('Other service properties are temporarily unavailable.');
      }
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
        setPropertiesError(null);
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

  // Cross-tab session sync. Logout in tab A only clears tab B's localStorage —
  // tab B's in-memory api.token kept working until its next 401. React to the
  // token key changing in ANOTHER tab (`storage` never fires in the tab that
  // wrote): removal ends this tab's session too; a new/changed token (login or
  // property switch elsewhere) is adopted so the tabs can't act as two
  // different customers.
  useEffect(() => {
    const onStorage = (event) => {
      // key === null means localStorage.clear(); otherwise only react to ours.
      if (event.key !== null && event.key !== 'waves_token') return;
      const token = localStorage.getItem('waves_token');
      if (token === (api.token || null)) return; // echo of our own state
      if (retryTimer.current) {
        clearTimeout(retryTimer.current);
        retryTimer.current = null;
      }
      if (!token) {
        api.clearTokens();
        customerRef.current = null;
        setCustomer(null);
        setProperties([]);
        setPropertiesError(null);
        setError(null);
        setLoading(false);
        return;
      }
      const nextId = tokenCustomerId(token);
      const identityChanged = nextId === null || nextId !== tokenCustomerId(api.token);
      api.adoptTokens(token, localStorage.getItem('waves_refresh_token'));
      if (identityChanged) {
        // The token now points at a DIFFERENT customer — the old one must not
        // keep rendering (and firing actions) against it while loadCustomer
        // is in flight or retrying. Same go-pending pattern as switchProperty;
        // a same-customer refresh skips this so working tabs don't flash.
        customerRef.current = null;
        setCustomer(null);
        setProperties([]);
        setPropertiesError(null);
        setError(null);
        setLoading(true);
      }
      loadCustomer();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [loadCustomer]);

  const sendCode = async (phone) => {
    setError(null);
    try {
      await api.sendCode(phone);
      return true;
    } catch (err) {
      setError(authErrorCopy(err));
      return false;
    }
  };

  const verifyCode = async (phone, code) => {
    setError(null);
    try {
      // A prior native logout may still be using the old credentials to
      // unsubscribe this device. Never let that cleanup erase a new login.
      if (logoutTokenReleaseRef.current) await logoutTokenReleaseRef.current;
      const data = await api.verifyCode(phone, code);
      api.setTokens(data.token, data.refreshToken);
      setProperties(data.properties || []);
      setPropertiesError(null);
      await loadCustomer();
      return true;
    } catch (err) {
      setError(authErrorCopy(err));
      return false;
    }
  };

  const logout = () => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    // Clear the rendered identity immediately. Credentials remain available
    // only to the bounded native-unsubscribe cleanup below; this keeps logout
    // responsive without abandoning a signed-out customer's private pushes.
    customerRef.current = null;
    setCustomer(null);
    setProperties([]);
    setPropertiesError(null);
    setError(null);
    setLoading(false);

    const tokenRelease = (async () => {
      let timeoutId;
      try {
        await Promise.race([
          deactivateNativePushToken(),
          new Promise((resolve) => { timeoutId = window.setTimeout(resolve, 4000); }),
        ]);
      } catch { /* best-effort device cleanup */ }
      if (timeoutId) window.clearTimeout(timeoutId);

      // Native cleanup may have refreshed and rotated the family. Capture the
      // newest credential, then remove both credentials together from this
      // tab and publish the access-token removal to other tabs.
      const refreshToken = api.refreshToken || localStorage.getItem('waves_refresh_token');
      api.clearTokens();

      // Revocation is non-blocking from the customer's perspective and does
      // not require an access JWT. It is deliberately started only after push
      // cleanup has had its chance to use/rotate the refresh credential.
      if (refreshToken) {
        api.request('/auth/logout', {
          method: 'POST',
          body: JSON.stringify({ refreshToken }),
        }).catch(() => {});
      }
    })();
    logoutTokenReleaseRef.current = tokenRelease;
    tokenRelease.finally(() => {
      if (logoutTokenReleaseRef.current === tokenRelease) logoutTokenReleaseRef.current = null;
    });
  };

  const refreshProperties = async () => {
    try {
      const data = await api.getAuthProperties();
      setProperties(data.properties || []);
      setPropertiesError(null);
      return true;
    } catch (err) {
      console.error('Failed to reload service properties:', err);
      setPropertiesError('Other service properties are temporarily unavailable.');
      return false;
    }
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
      setPropertiesError(null);
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
      propertiesError,
      loading,
      error,
      isAuthenticated: !!customer,
      sendCode,
      verifyCode,
      switchProperty,
      refreshProperties,
      logout,
      clearError: () => setError(null),
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
