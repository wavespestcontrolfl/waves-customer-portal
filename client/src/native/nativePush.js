/**
 * Native (iOS + Android) push registration for the Capacitor shell.
 *
 * Uses the real Capacitor plugin APIs. `@capacitor/core` is web-safe — its
 * `isNativePlatform()` returns false in a browser — and gates everything. The
 * heavier `@capacitor/push-notifications` is dynamically imported only on the
 * native platform; importing it is what registers its JS proxy on
 * `window.Capacitor.Plugins` (compiling the native plugin alone does NOT — Codex
 * P1 on #1963). On the web this module is an inert no-op.
 *
 * Flow:
 *   1. requestPermissions() → register() (registers with APNs on iOS, FCM on Android)
 *   2. 'registration' event fires with the device token (APNs token / FCM token)
 *   3. POST the token to the backend with the REAL platform ('ios'|'android') so it
 *      routes to APNs vs FCM. A fresh install lands on /login unauthenticated, so if
 *      no JWT exists yet the token is cached and flushNativePushToken() (wired into
 *      the auth flow) posts it after login.
 *
 * The web push path (lib/push-subscribe.js + /admin/push/subscribe) is untouched.
 */
import api from '../utils/api';
import { isNativeApp, nativePlatform } from './platform';
import { navigateToCustomerUrl } from './nativeLinks';

export { isNativeApp };

let pendingToken = null;
// Last token this session posted (or tried to). Capacitor's 'registration'
// event only fires once per app session, so logout/login and property
// switches must reuse it to deactivate/re-point the subscription. Persisted
// so a logout in a LATER app session (no registration event yet) can still
// scope the unsubscribe to this device's token.
let lastToken = null;
const LAST_TOKEN_KEY = 'waves_native_push_token';
let listenersBound = false;
let pushPluginPromise = null;
// Logout's unsubscribe request while it's on the wire. postToken() awaits it
// so a quick logout→login re-subscribe can't reach the server first and then
// be deactivated when the older unsubscribe lands.
let inflightDeactivation = null;

function rememberToken(token) {
  lastToken = token;
  try { localStorage.setItem(LAST_TOKEN_KEY, token); } catch { /* storage unavailable */ }
}

function rememberedToken() {
  if (lastToken) return lastToken;
  try { return localStorage.getItem(LAST_TOKEN_KEY) || null; } catch { return null; }
}

function authToken() {
  if (typeof localStorage === 'undefined') return '';
  // Customer-only: this is the customer App Store app. Staff/tech use the
  // separate WavesPay app, and /admin + /tech are redirected out of the native
  // shell, so we never register a staff token here (no admin-token fallback —
  // that would leave a staff APNs token stranded since the customer login flow
  // is the only flush path).
  return localStorage.getItem('waves_token') || '';
}

async function postToken(token) {
  rememberToken(token);
  const jwt = authToken();
  if (!jwt) {
    // Not authenticated yet — hold the token; the login flow flushes it.
    pendingToken = token;
    return;
  }
  // Post the real platform so the backend routes iOS tokens to APNs and Android
  // tokens to FCM. (On Android, Capacitor's 'registration' event delivers an FCM
  // token here.) Default to 'ios' for anything non-Android (this only runs on a
  // native platform — initNativePush gates on isNativeApp).
  const platform = nativePlatform() === 'android' ? 'android' : 'ios';
  try {
    if (inflightDeactivation) await inflightDeactivation;
    const res = await fetch('/api/push/native-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ platform, token, deviceInfo: `${platform} · WavesApp` }),
    });
    if (!res.ok) {
      console.warn('[nativePush] token registration returned', res.status);
      pendingToken = token; // let a later flush retry
    }
  } catch (err) {
    console.warn('[nativePush] token registration failed:', err?.message || err);
    pendingToken = token; // retry on next flush
  }
}

function pushPlugin() {
  if (!pushPluginPromise) {
    pushPluginPromise = import('@capacitor/push-notifications')
      .then(({ PushNotifications }) => PushNotifications)
      .catch((error) => {
        pushPluginPromise = null;
        throw error;
      });
  }
  return pushPluginPromise;
}

async function bindPushListeners(PushNotifications) {
  if (listenersBound) return;
  listenersBound = true;
  try {
    await PushNotifications.addListener('registration', (t) => {
      if (t?.value) postToken(t.value);
    });
    await PushNotifications.addListener('registrationError', (err) => {
      console.error('[nativePush] push registration error:', err?.error || err);
    });
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      const url = action?.notification?.data?.url;
      if (url && typeof window !== 'undefined') navigateToCustomerUrl(url);
    });
  } catch (error) {
    // A partial bind must be retryable after an app/plugin recovery.
    listenersBound = false;
    throw error;
  }
}

function permissionValue(permission) {
  const state = permission?.receive;
  if (state === 'granted' || state === 'denied' || state === 'prompt' || state === 'prompt-with-rationale') {
    return state;
  }
  return 'unavailable';
}

/** Return the current native permission without triggering an OS prompt. */
export async function nativePushPermissionState() {
  if (!isNativeApp()) return 'unavailable';
  try {
    const PushNotifications = await pushPlugin();
    await bindPushListeners(PushNotifications);
    return permissionValue(await PushNotifications.checkPermissions());
  } catch {
    return 'unavailable';
  }
}

/**
 * Ask for native push from an explicit customer gesture (the notification
 * drawer's Enable button). A denied permission is reported to the caller so
 * it can direct the customer to device Settings instead of leaving a dead UI.
 */
export async function requestNativePushPermission() {
  if (!isNativeApp()) return 'unavailable';
  try {
    const PushNotifications = await pushPlugin();
    await bindPushListeners(PushNotifications);
    let state = permissionValue(await PushNotifications.checkPermissions());
    if (state === 'prompt' || state === 'prompt-with-rationale') {
      state = permissionValue(await PushNotifications.requestPermissions());
    }
    if (state === 'granted') await PushNotifications.register();
    return state;
  } catch (err) {
    console.error('[nativePush] permission request failed:', err?.message || err);
    return 'unavailable';
  }
}

/**
 * Bind listeners + request permission + register with APNs. Call once at
 * startup. No-op on web; safe to call again.
 */
export async function initNativePush() {
  if (!isNativeApp()) return;
  try {
    const PushNotifications = await pushPlugin();
    await bindPushListeners(PushNotifications);

    // Startup may silently recover an already-granted registration, but it
    // must never surprise a newly installed customer with an OS prompt before
    // the app has explained the value. Prompting happens only from
    // requestNativePushPermission(), called by the bell's Enable action.
    const state = permissionValue(await PushNotifications.checkPermissions());
    if (state === 'granted') {
      await PushNotifications.register();
    }
  } catch (err) {
    console.error('[nativePush] init failed:', err?.message || err);
  }
}

/**
 * Flush a token captured before login. Call from the auth flow once a JWT is
 * present (see hooks/useAuth.jsx). No-op on web or when nothing is pending.
 */
export function flushNativePushToken() {
  if (!isNativeApp()) return;
  if (!pendingToken) return;
  const token = pendingToken;
  pendingToken = null;
  postToken(token);
}

/**
 * Deactivate this customer's native push registration. AWAIT from logout
 * BEFORE clearTokens — it may need the api client's 401→refresh retry,
 * which needs live tokens — so the device stops receiving the previous
 * account's service/billing pushes. Best-effort; no-op on web. Re-arms
 * pendingToken so a later login on this device re-subscribes (the
 * registration event won't re-fire this session).
 */
export async function deactivateNativePushToken() {
  if (!isNativeApp()) return;
  // The access JWT can be expired at logout while the 30-day refresh token
  // is still valid (7d vs 30d defaults) — so this goes through the api
  // client, whose 401→refresh→retry path recovers that case. A raw fetch
  // with the stale Bearer just 401s and leaves this device receiving the
  // old account's pushes. Requires logout to await this BEFORE clearTokens
  // (the refresh path dies once tokens are cleared).
  let refreshJwt = null;
  try { refreshJwt = localStorage.getItem('waves_refresh_token'); } catch { /* storage unavailable */ }
  if (!authToken() && !refreshJwt) return;
  const token = rememberedToken();
  // Never unsubscribe without the device token: the server route deactivates
  // EVERY native subscription for the customer when token is omitted, which
  // would kill the household's other devices. No token remembered means this
  // device never registered — nothing to deactivate for it.
  if (!token) return;
  // Re-arm BEFORE the network round-trip: a quick logout→login flushes
  // pendingToken during loadCustomer, and a post-await assignment can run
  // after that flush already no-opped — leaving the device unsubscribed
  // until the next Capacitor registration event (app restart).
  pendingToken = token;
  const request = (async () => {
    try {
      // api.request throws on non-OK, so a failed unsubscribe lands in the
      // catch — pendingToken stays armed and the next login's flush re-points
      // the subscription (which supersedes the old row server-side).
      await api.request('/push/native-unsubscribe', {
        method: 'POST',
        body: JSON.stringify({ token }),
      });
    } catch (err) {
      console.warn('[nativePush] token deactivation failed:', err?.message || err);
    }
  })();
  inflightDeactivation = request;
  try {
    await request;
  } finally {
    if (inflightDeactivation === request) inflightDeactivation = null;
  }
}

/**
 * Re-post the current device token under the now-authenticated customer —
 * used after a property switch so the subscription row re-points to the
 * new customer_id instead of silently notifying the old one.
 */
export function repostNativePushToken() {
  if (!isNativeApp()) return;
  const token = rememberedToken();
  if (!token) return;
  postToken(token);
}
