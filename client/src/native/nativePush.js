/**
 * Native (iOS) push registration for the Capacitor shell.
 *
 * This deliberately talks to the Capacitor bridge via the injected
 * `window.Capacitor` global rather than importing `@capacitor/push-notifications`.
 * That keeps the existing web build green even before the Capacitor deps are
 * installed: on the web `window.Capacitor` is undefined and every function here
 * is an inert no-op. Inside the native shell the bridge is injected by the
 * runtime and `Plugins.PushNotifications` is available because the native plugin
 * is compiled in (see scripts/mobile/bootstrap-ios.sh).
 *
 * Flow:
 *   1. requestPermissions() → register() (registers with APNs)
 *   2. 'registration' event fires with the APNs device token
 *   3. POST the token to the backend so it lands in push_subscriptions with
 *      platform='ios' (see docs/mobile/apns-backend-pr-plan.md for the route).
 *
 * The web path (lib/push-subscribe.js + /admin/push/subscribe) is untouched.
 */

function bridge() {
  if (typeof window === 'undefined') return null;
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  return cap.Plugins || null;
}

export function isNativeApp() {
  return Boolean(bridge());
}

/**
 * Send the APNs token to the portal. The portal authenticates with a Bearer
 * JWT (not cookies) — customer token is `waves_token`, admin/tech is
 * `waves_admin_token` — so we attach whichever is present. The matching
 * endpoint (/api/push/native-subscribe) is scoped to the customer session; see
 * the APNs backend PR. Fails soft until that endpoint is deployed.
 */
function authToken() {
  if (typeof localStorage === 'undefined') return '';
  return localStorage.getItem('waves_token') || localStorage.getItem('waves_admin_token') || '';
}

async function sendTokenToServer(token) {
  try {
    const jwtToken = authToken();
    if (!jwtToken) {
      console.info('[nativePush] no auth token yet — deferring registration until login');
      return;
    }
    const res = await fetch('/api/push/native-subscribe', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwtToken}`,
      },
      body: JSON.stringify({
        platform: 'ios',
        token,
        deviceInfo: 'iOS · WavesApp',
      }),
    });
    if (!res.ok) {
      console.warn('[nativePush] token registration returned', res.status);
    }
  } catch (err) {
    console.warn('[nativePush] token registration failed:', err?.message || err);
  }
}

/**
 * Call once after the user is authenticated. Safe to call on web (no-op) and
 * safe to call more than once (Capacitor de-dupes listeners per add).
 */
export async function initNativePush() {
  const plugins = bridge();
  if (!plugins) return; // web / non-native — nothing to do
  const Push = plugins.PushNotifications;
  if (!Push) return;

  try {
    // Token arrives here after a successful register().
    await Push.addListener('registration', (token) => {
      const value = token?.value;
      if (value) sendTokenToServer(value);
    });

    await Push.addListener('registrationError', (err) => {
      console.error('[nativePush] APNs registration error:', err?.error || err);
    });

    // Tapping a notification — route the webview to the deep-linked path.
    await Push.addListener('pushNotificationActionPerformed', (action) => {
      const url = action?.notification?.data?.url;
      if (url && typeof window !== 'undefined') {
        try { window.location.assign(url); } catch { /* ignore */ }
      }
    });

    const perm = await Push.requestPermissions();
    if (perm?.receive === 'granted') {
      await Push.register();
    } else {
      console.info('[nativePush] push permission not granted:', perm?.receive);
    }
  } catch (err) {
    console.error('[nativePush] init failed:', err?.message || err);
  }
}
