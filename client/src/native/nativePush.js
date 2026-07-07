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
import { isNativeApp, nativePlatform } from './platform';

export { isNativeApp };

let pendingToken = null;
// Last token this session posted (or tried to). Capacitor's 'registration'
// event only fires once per app session, so logout/login and property
// switches must reuse it to deactivate/re-point the subscription.
let lastToken = null;
let listenersBound = false;

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
  lastToken = token;
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

/**
 * Bind listeners + request permission + register with APNs. Call once at
 * startup. No-op on web; safe to call again.
 */
export async function initNativePush() {
  if (!isNativeApp()) return;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    if (!listenersBound) {
      listenersBound = true;
      await PushNotifications.addListener('registration', (t) => {
        if (t?.value) postToken(t.value);
      });
      await PushNotifications.addListener('registrationError', (err) => {
        console.error('[nativePush] APNs registration error:', err?.error || err);
      });
      // Tapping a notification — route the webview to the deep-linked path.
      await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const url = action?.notification?.data?.url;
        if (url && typeof window !== 'undefined') {
          try { window.location.assign(url); } catch { /* ignore */ }
        }
      });
    }

    const perm = await PushNotifications.requestPermissions();
    if (perm?.receive === 'granted') {
      await PushNotifications.register();
    } else {
      console.info('[nativePush] push permission not granted:', perm?.receive);
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
 * Deactivate this customer's native push registration. Call from logout
 * BEFORE tokens are cleared (it needs the JWT) so the device stops
 * receiving the previous account's service/billing pushes. Best-effort;
 * no-op on web. Re-arms pendingToken so a later login on this device
 * re-subscribes (the registration event won't re-fire this session).
 */
export async function deactivateNativePushToken() {
  if (!isNativeApp()) return;
  const jwt = authToken();
  if (!jwt) return;
  const token = lastToken;
  try {
    await fetch('/api/push/native-unsubscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify(token ? { token } : {}),
    });
  } catch (err) {
    console.warn('[nativePush] token deactivation failed:', err?.message || err);
  }
  if (token) pendingToken = token;
}

/**
 * Re-post the current device token under the now-authenticated customer —
 * used after a property switch so the subscription row re-points to the
 * new customer_id instead of silently notifying the old one.
 */
export function repostNativePushToken() {
  if (!isNativeApp() || !lastToken) return;
  postToken(lastToken);
}
