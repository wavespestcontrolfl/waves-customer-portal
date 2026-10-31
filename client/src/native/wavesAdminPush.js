// Staff alerts inside Waves Admin, the iOS staff app (ios/WavesPay). Its web
// view cannot run web push or the Badging API, so the app delivers alerts as
// iPhone notifications and sets the icon badge itself.
//
// The signed-in page asks the app for its APNs device token (the app asks the
// staff member for permission first) and registers the token under its own
// staff sign-in, so the app never holds the staff token. The app answers with
// a 'wavesadmin:pushtoken' window event: detail = { token, environment }.
// Sign-out releases the token again (releaseInAppPush), and the app stops
// this install's notifications until the next sign-in registers again.

import { adminFetch } from '../lib/adminFetch';
import { isWavesAdminApp } from './platform';

const TOKEN_EVENT = 'wavesadmin:pushtoken';
// This iPhone's registered token. Stored, so a sign-out after a page reload
// still releases it.
const TOKEN_KEY = 'waves_admin_push_token';
const RELEASE_ATTEMPTS = 3;

// The sign-up request in flight; a release waits for it to land first.
let registering = Promise.resolve();
// Bumped by every registerInAppPush and every release, so a token that
// arrives after a sign-out never registers.
let epoch = 0;

function postToApp(message) {
  window.webkit.messageHandlers.wavesAdmin.postMessage(message);
}

// Returns a cleanup for sign-out and account switches.
export function registerInAppPush() {
  if (!isWavesAdminApp()) return () => {};
  const mine = ++epoch;
  const onToken = (event) => {
    const { token, environment } = event?.detail || {};
    if (mine !== epoch || !token) return;
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* storage unavailable */ }
    registering = adminFetch('/admin/push/native-subscribe', { method: 'POST', body: { token, environment } }).catch(() => {});
  };
  window.addEventListener(TOKEN_EVENT, onToken);
  postToApp({ type: 'registerPush' });
  return () => window.removeEventListener(TOKEN_EVENT, onToken);
}

// Sign-out: stop this iPhone's staff alerts before the credentials go. The
// app clears shown alerts and the badge and stops this install's
// notifications at once, so nothing more shows even if the server cannot be
// reached. The server release waits for a sign-up still in flight, so that
// one cannot land after it, and is retried on failure. Never rejects.
export function releaseInAppPush() {
  if (!isWavesAdminApp()) return Promise.resolve();
  epoch += 1;
  postToApp({ type: 'signOut' });
  let token = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
  } catch { /* storage unavailable */ }
  if (!token) return Promise.resolve();
  const auth = localStorage.getItem('waves_admin_token');
  const release = async () => {
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt += 1) {
      const response = await adminFetch('/admin/push/native-unsubscribe', {
        method: 'POST',
        body: { token },
        headers: { Authorization: `Bearer ${auth}` },
      }).catch(() => null);
      if (response?.ok) return;
      if (attempt < RELEASE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  };
  return registering.then(release, release);
}

// True when the app took the count, so the caller skips the Badging API.
export function setInAppBadge(count) {
  if (!isWavesAdminApp()) return false;
  const value = Number.isSafeInteger(count) && count > 0 ? count : 0;
  postToApp({ type: 'badge', count: value });
  return true;
}
