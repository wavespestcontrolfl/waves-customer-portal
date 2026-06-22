/**
 * Native (iOS) push registration for the Capacitor shell.
 *
 * Uses the real Capacitor plugin APIs. `@capacitor/core` is web-safe — its
 * `isNativePlatform()` returns false in a browser — and gates everything. The
 * heavier `@capacitor/push-notifications` is dynamically imported only on the
 * native platform; importing it is what registers its JS proxy on
 * `window.Capacitor.Plugins` (compiling the native pod alone does NOT — Codex
 * P1 on #1963). On the web this module is an inert no-op.
 *
 * Flow:
 *   1. requestPermissions() → register() (registers with APNs)
 *   2. 'registration' event fires with the APNs device token
 *   3. POST the token to the backend (platform='ios'). A fresh install lands on
 *      /login unauthenticated, so if no JWT exists yet the token is cached and
 *      flushNativePushToken() (wired into the auth flow) posts it after login.
 *
 * The web push path (lib/push-subscribe.js + /admin/push/subscribe) is untouched.
 */
import { isNativeApp } from './platform';

export { isNativeApp };

let pendingToken = null;
let listenersBound = false;

function authToken() {
  if (typeof localStorage === 'undefined') return '';
  // Customer JWT first; admin/tech token as a fallback (the portal serves both).
  return localStorage.getItem('waves_token') || localStorage.getItem('waves_admin_token') || '';
}

async function postToken(token) {
  const jwt = authToken();
  if (!jwt) {
    // Not authenticated yet — hold the token; the login flow flushes it.
    pendingToken = token;
    return;
  }
  try {
    const res = await fetch('/api/push/native-subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ platform: 'ios', token, deviceInfo: 'iOS · WavesApp' }),
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
