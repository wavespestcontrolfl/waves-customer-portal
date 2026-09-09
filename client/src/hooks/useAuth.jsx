import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '../utils/api';
import { deactivateNativePushToken, flushNativePushToken, repostNativePushToken } from '../native/nativePush';
import { clearNativeBadge } from '../native/nativeBadge';

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
export function tokenCustomerId(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
    return payload.customerId ?? null;
  } catch {
    return null;
  }
}

// Session-family identity: a fresh code login mints a NEW sessionId even for
// the same customer (server generateToken), and responses in flight under
// the OLD family must not act on the new one — in particular a stale
// /auth/me 401 must not clear freshly adopted credentials. A same-family
// access-token rotation keeps the family.
function tokenSessionIdentity(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
    if (payload.customerId == null) return null;
    return {
      customerId: String(payload.customerId),
      sessionId: payload.sessionId == null ? null : String(payload.sessionId),
    };
  } catch {
    return null;
  }
}

// Selected saved property baked into the session JWT (GATE_APP_PROPERTY_SCOPE;
// server/middleware/auth.js `propertyId` claim). Null when the token carries
// none (profile scope, or the primary).
export function tokenPropertyId(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '=')));
    return payload.propertyId == null ? null : String(payload.propertyId);
  } catch {
    return null;
  }
}

// Same ASYMMETRIC semantics as api.js sameRequestSession: only the OLD
// (current) side wildcards — a legacy token with no sessionId upgrading
// into a durable family via its first routine refresh is the same session,
// but an INCOMING sessionId-less token replacing a durable session is a
// different family (it can only come from a re-login on an old deploy /
// stale bundle, and old-family responses must not stay valid under it).
function sameSessionFamily(a, b) {
  return !!a && !!b
    && a.customerId === b.customerId
    && (a.sessionId === null || a.sessionId === b.sessionId);
}

// Saved-property entries (GET /auth/properties?scope=saved, GATE_APP_PROPERTY_SCOPE)
// rendered through the client property shape every switcher already uses
// (id / profileLabel / isPrimaryProfile / address / tier), keyed by the entry
// key so three saved properties on one profile stay distinct. The label is
// what the picker, the chips and the Visits header print.
export function savedPropertyDisplayLabel(entry) {
  if (entry.label && entry.label !== 'Primary') return entry.label;
  if (entry.isPrimaryProperty) {
    return entry.profileLabel && entry.profileLabel !== 'Primary' ? entry.profileLabel : 'Home';
  }
  // Secondary saved property: the street keeps two "Family home" entries apart.
  return entry.address?.line1 || 'Property';
}

export function toClientProperty(entry) {
  return {
    ...entry,
    id: entry.key,
    profileLabel: savedPropertyDisplayLabel(entry),
    // "Primary residence" (home tile) = the primary profile's primary property.
    isPrimaryProfile: entry.isPrimaryProfile === true && entry.isPrimaryProperty === true,
  };
}

// Pure: the /auth/properties payload → { scope, properties, selected }.
// A profile-list answer (gate off, or an older server) keeps today's shape.
export function applyPropertyPayload(data) {
  if (data?.scope === 'saved') {
    return { scope: 'saved', properties: (data.properties || []).map(toClientProperty), selected: data.selected || null };
  }
  return { scope: 'profile', properties: data?.properties || [], selected: null };
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
  // Saved-property scope: which list shape `properties` holds ('profile' |
  // 'saved') and the session's current selection { key, customerId, propertyId }.
  const [propertyScope, setPropertyScope] = useState('profile');
  const propertyScopeRef = useRef('profile');
  const [selectedProperty, setSelectedProperty] = useState(null);
  // Mirror of `properties` for the storage handler (stable callback, stale closure).
  const propertiesRef = useRef([]);
  useEffect(() => { propertiesRef.current = properties; }, [properties]);
  const adoptPropertyPayload = (data) => {
    const payload = applyPropertyPayload(data);
    propertyScopeRef.current = payload.scope;
    setPropertyScope(payload.scope);
    setProperties(payload.properties);
    setSelectedProperty(payload.selected);
  };
  // Session boundary (logout, a new login, another tab's sign-out or a
  // different customer's token): the previous session's selection must never
  // outlive it — a later failed list read would otherwise leave a stale house
  // selected while the new token scopes reads elsewhere (codex #4207 r1c).
  const resetPropertyScope = () => {
    propertyScopeRef.current = 'profile';
    setPropertyScope('profile');
    setSelectedProperty(null);
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const retryTimer = useRef(null);
  // Property-list reads race: loadCustomer's read, refreshProperties (the
  // shared refresh cycle, the revalidator — whose 15s bound abandons but
  // does not cancel the underlying request) and a later switch overlap
  // under ONE session epoch. Only the LATEST-issued read may adopt its
  // payload or its failure (uncapped codex r1s P1): a delayed older response
  // would otherwise restore a retired house's selection after a newer read
  // already adopted the fallback.
  const propertyReadSeqRef = useRef(0);
  const logoutTokenReleaseRef = useRef(null);
  // Mirrors `customer` for reads inside the stable loadCustomer callback
  // (empty deps ⇒ stale closure) — the transient branch needs to know
  // whether a session is already on screen.
  const customerRef = useRef(null);
  // Session epoch: bumped on every identity transition (login, logout,
  // property switch, cross-tab adoption). Async auth flows capture the epoch
  // when they START and discard their response if it moved while in flight —
  // a delayed /auth/select-property response must not rewrite tokens after
  // Sign out, and a slow /auth/me must not paint a previous identity over
  // the one the current token authenticates (last-response-wins).
  const sessionEpochRef = useRef(0);
  const [sessionEpoch, setSessionEpoch] = useState(0);

  // Check for existing session on mount
  useEffect(() => {
    const token = localStorage.getItem('waves_token');
    if (token) {
      api.adoptTokens(token, localStorage.getItem('waves_refresh_token'));
      loadCustomer();
    } else {
      void clearNativeBadge();
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
    const epoch = sessionEpochRef.current;
    if (retryTimer.current) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    try {
      const data = await api.getMe();
      // The session changed while this response was in flight (logout,
      // property switch, cross-tab adoption) — a load for the NEW epoch is
      // already running; applying this one would paint a stale identity.
      if (sessionEpochRef.current !== epoch) return;
      // Cancelled accounts never mount the bell, including on a fresh launch.
      if (data?.cancelled === true) void clearNativeBadge();
      customerRef.current = data;
      setCustomer(data);
      const propertyReadSeq = ++propertyReadSeqRef.current;
      try {
        const propertyData = await api.getAuthProperties({ scope: 'saved' });
        if (sessionEpochRef.current !== epoch) return;
        // Superseded by a newer list read: that read owns the selection.
        if (propertyReadSeqRef.current === propertyReadSeq) {
          adoptPropertyPayload(propertyData);
          setPropertiesError(null);
        }
      } catch (propertyErr) {
        // Same staleness rule as the success path: if the session changed
        // while this secondary fetch was in flight, this failure describes a
        // DEAD session — falling through would drop the loading screen
        // (setLoading(false) below) while the previous customer's state is
        // still rendered under the new token.
        if (sessionEpochRef.current !== epoch) return;
        // A newer list read is in flight or has landed: it owns the
        // selection and the error state; this stale failure changes nothing.
        if (propertyReadSeqRef.current === propertyReadSeq) {
        // A saved-property session scopes every read to the selection the
        // SERVER RESOLVED even when the list cannot be read (codex #4207 r1 /
        // r1e / r1w): take it from /auth/me's `propertyScope` — the honored
        // claim, else the fallback the server chose (a lone secondary after
        // the primary was retired), else `closed` — never the raw token
        // claim. The entry details arrive with the next refresh.
        const claimed = data?.propertyScope?.propertyId ? String(data.propertyScope.propertyId) : null;
        if (data?.propertyScope && data.propertyScope.enabled === false) {
          // The server is NOT scoping this session (gate off, cancelled): the
          // saved-property labels must go with it, even though the list could
          // not be re-read — composite entries would otherwise dress
          // customer-wide reads as one house. The next successful list read
          // (profile shape) restores the switcher.
          resetPropertyScope();
          if (propertiesRef.current.some((p) => p.key)) setProperties([]);
        } else if (data?.propertyScope?.closed === true && data?.id) {
          // Every saved property of this profile retired — the server resolved
          // NO house (uncapped codex r1w P1): the session is scoped to nothing
          // selectable. Saved scope with a null-key selection, which the page
          // reads as "property unavailable" (no address, the profile-scoped
          // My Property notice, no ticket) — never the retired primary's
          // screens. A successful list read lands the same shape.
          propertyScopeRef.current = 'saved';
          setPropertyScope('saved');
          setSelectedProperty({ key: null, customerId: data.id, propertyId: null, closed: true });
        } else if (claimed && data?.id) {
          setSelectedProperty((prev) => (prev && String(prev.propertyId) === claimed && String(prev.customerId) === String(data.id)
            ? prev
            : { key: `${data.id}:${claimed}`, customerId: data.id, propertyId: claimed }));
        } else {
          // No claim = this profile's PRIMARY. Resolve it from the entries
          // already held (a profile-only switch keeps the unified list, and
          // customer.id matches no composite key), else leave the selection
          // unavailable — never a leftover house from an earlier session.
          const mine = (propertiesRef.current || []).filter((p) => String(p.customerId || p.id) === String(data?.id));
          const primaryEntry = mine.find((p) => p.isPrimaryProperty) || (mine.length === 1 ? mine[0] : null);
          setSelectedProperty(primaryEntry && primaryEntry.propertyId !== undefined
            ? { key: primaryEntry.id, customerId: primaryEntry.customerId, propertyId: primaryEntry.propertyId }
            : null);
        }
        // The active customer is still valid. Preserve any property list we
        // already have instead of collapsing a multi-property account to a
        // single property, and surface a retry in the account menu.
        console.error('Failed to load service properties:', propertyErr);
        setPropertiesError('Other service properties are temporarily unavailable.');
        }
      }
      setError(null);
      // Now authenticated — flush any APNs token captured before login (native
      // app only; no-op on web). See native/nativePush.js.
      flushNativePushToken();
    } catch (err) {
      // A stale failure must act on NOTHING: in particular, a 401 for a
      // token that has since been replaced would clear the NEW session's
      // credentials.
      if (sessionEpochRef.current !== epoch) return;
      console.error('Failed to load customer:', err);
      // Only a real auth rejection invalidates the session — a network drop
      // or server 5xx on launch must not wipe a valid 30-day login.
      if (err?.status === 401 || err?.status === 403 || err?.sessionExpired) {
        // The session is DEAD — every other in-flight auth response
        // (a concurrent property switch, another load) must be discarded
        // too, or its later success would adopt tokens / repaint the
        // customer and undo this sign-out.
        setSessionEpoch(++sessionEpochRef.current);
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
        setSessionEpoch(++sessionEpochRef.current);
        api.clearTokens();
        customerRef.current = null;
        setCustomer(null);
        setProperties([]);
        resetPropertyScope();
        setPropertiesError(null);
        setError(null);
        setLoading(false);
        return;
      }
      const nextId = tokenCustomerId(token);
      const identityChanged = nextId === null || nextId !== tokenCustomerId(api.token);
      // Bump the epoch on any SESSION-FAMILY change — a different customer
      // OR a fresh login's new sessionId for the same customer — so
      // in-flight responses from the old family are discarded (a stale
      // /auth/me 401 must not clear the newly adopted credentials). A
      // same-family rotation, including a legacy token's first
      // sessionId-upgrading refresh, keeps the epoch so it cannot supersede
      // this tab's in-flight flows (e.g. a property switch mid-await) —
      // that identity is still current (Codex #2859 r1+r2+r3).
      const familyChanged = !sameSessionFamily(tokenSessionIdentity(api.token), tokenSessionIdentity(token));
      // A same-profile SAVED-PROPERTY switch in another tab rotates the
      // family but changes the token's propertyId. The selection this tab
      // shows must follow it, and a property list still in flight from
      // BEFORE the switch must not land afterwards and paint the previous
      // selection — so it counts as an identity transition for the epoch.
      const propertyChanged = tokenPropertyId(api.token) !== tokenPropertyId(token);
      if (familyChanged || propertyChanged) setSessionEpoch(++sessionEpochRef.current);
      api.adoptTokens(token, localStorage.getItem('waves_refresh_token'));
      if (propertyChanged && !identityChanged) {
        // The previous selection is gone the moment the token changes, and
        // the new one is NOT reconstructed from the raw claim (the server may
        // ignore it: retired property, gate off). Go PENDING exactly like a
        // profile switch (codex #4207 r1g P1): the old customer must not keep
        // rendering house A's label while requests already run under house
        // B's token; loadCustomer below adopts the selection the server
        // honored (/auth/me propertyScope, then the list), and its retry
        // branch keeps the shell pending on failure.
        setSelectedProperty(null);
        customerRef.current = null;
        setCustomer(null);
        setLoading(true);
      }
      if (identityChanged) {
        // The token now points at a DIFFERENT customer — the old one must not
        // keep rendering (and firing actions) against it while loadCustomer
        // is in flight or retrying. Same go-pending pattern as switchProperty;
        // a same-customer refresh skips this so working tabs don't flash.
        customerRef.current = null;
        setCustomer(null);
        setProperties([]);
        resetPropertyScope();
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
      const epoch = sessionEpochRef.current;
      const data = await api.verifyCode(phone, code);
      // Another tab logged in / adopted a session while the code verified.
      if (sessionEpochRef.current !== epoch) return false;
      setSessionEpoch(++sessionEpochRef.current);
      api.setTokens(data.token, data.refreshToken);
      resetPropertyScope();
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
    void clearNativeBadge();
    // Invalidate every in-flight auth response (property switch, /auth/me)
    // — without this, a delayed switch response re-writes tokens after
    // sign-out and walks the user back into the portal.
    setSessionEpoch(++sessionEpochRef.current);
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
    resetPropertyScope();
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

  // Stable identity (uncapped codex r1t P1): the tabs re-read the list from
  // an effect keyed on this callback; a new function per provider render
  // would re-fire that effect after every successful refresh — an endless
  // loop while the selection stays stale (every property retired). Only
  // refs and setters inside, so an empty dependency list is exact.
  const refreshProperties = useCallback(async () => {
    // Same staleness rule as loadCustomer: a response (or failure) that
    // started under a superseded session must not overwrite the new
    // session's property list or surface its error.
    const epoch = sessionEpochRef.current;
    const seq = ++propertyReadSeqRef.current;
    try {
      const data = await api.getAuthProperties({ scope: 'saved' });
      if (sessionEpochRef.current !== epoch) return false;
      // Superseded by a newer list read (uncapped codex r1s P1): a delayed
      // response must not restore a house a newer read already retired.
      if (propertyReadSeqRef.current !== seq) return false;
      adoptPropertyPayload(data);
      setPropertiesError(null);
      return true;
    } catch (err) {
      if (sessionEpochRef.current !== epoch || propertyReadSeqRef.current !== seq) return false;
      console.error('Failed to reload service properties:', err);
      setPropertiesError('Other service properties are temporarily unavailable.');
      return false;
    }
  }, []);

  // target: a profile id (string — every shipped caller) or a saved-property
  // pair { customerId, propertyId } (GATE_APP_PROPERTY_SCOPE). A same-profile
  // property switch re-issues the tokens with the new claim; every read then
  // re-scopes exactly as a profile switch does.
  const switchProperty = async (target) => {
    const { customerId, propertyId = null } = typeof target === 'string' ? { customerId: target } : (target || {});
    if (!customerId) return false;
    setError(null);
    try {
      const epoch = sessionEpochRef.current;
      const data = await api.selectAuthProperty(customerId, propertyId);
      // Signed out (or superseded by another transition) while the switch
      // was in flight — the response must not restore credentials. The
      // server has revoked the family on logout, so the returned tokens are
      // a ≤15-minute zombie; never adopt them.
      if (sessionEpochRef.current !== epoch) return false;
      setSessionEpoch(++sessionEpochRef.current);
      api.setTokens(data.token, data.refreshToken);
      // Re-point this device's push subscription at the newly selected
      // customer — otherwise pushes keep flowing to the previous property.
      // (The subscription follows the customer ROW; a same-profile saved-
      // property switch keeps it.)
      if (String(customerId) !== String(customerRef.current?.id)) repostNativePushToken();
      // The token now points at the TARGET property — the old customer must
      // not keep rendering (and firing actions) against it if the reload
      // hits a transient failure. Go pending until the target customer
      // loads; loadCustomer's retry branch keeps it pending on failure.
      customerRef.current = null;
      setLoading(true);
      // The switch response carries the PROFILE list (shipped-client shape).
      // Under the saved-property scope the unified list is re-read by
      // loadCustomer (GET /auth/properties?scope=saved); adopting the profile
      // list here would collapse three saved properties into one entry.
      if (propertyScopeRef.current !== 'saved') setProperties(data.properties || []);
      // The switch response names the selection by ids; the entry key the
      // page compares against is derived the same way the server keys its
      // list (`customerId:propertyId`, or `:profile` for a row-less profile).
      if (data.selected) {
        const sel = data.selected;
        setSelectedProperty({ ...sel, key: sel.key || `${sel.customerId}:${sel.propertyId || 'profile'}` });
      }
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
      sessionEpoch,
      properties,
      propertiesError,
      propertyScope,
      selectedProperty,
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
