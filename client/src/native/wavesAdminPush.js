// Staff alerts inside Waves Admin, the iOS staff app (ios/WavesPay). Its web
// view cannot run web push or the Badging API, so the app delivers alerts as
// iPhone notifications and sets the icon badge itself.
//
// The signed-in page asks the app for its APNs device token (the app asks the
// staff member for permission first) and registers the token under its own
// staff sign-in, so the app never holds the staff token. The app answers with
// a 'wavesadmin:pushtoken' window event: detail = { token, environment }.
// Sign-out releases the token again (releaseInAppPush).

import { adminFetch } from '../lib/adminFetch';
import { isWavesAdminApp } from './platform';

const TOKEN_EVENT = 'wavesadmin:pushtoken';

// This device's sign-up: its token and the staff sign-in that registered it.
let registered = null;
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
    registered = { token, auth: localStorage.getItem('waves_admin_token') };
    registering = adminFetch('/admin/push/native-subscribe', { method: 'POST', body: { token, environment } }).catch(() => {});
  };
  window.addEventListener(TOKEN_EVENT, onToken);
  postToApp({ type: 'registerPush' });
  return () => window.removeEventListener(TOKEN_EVENT, onToken);
}

// Sign-out: stop this iPhone's staff alerts before the credentials go. It
// waits for a sign-up still in flight, so that one cannot land after the
// release, and has the app clear shown alerts and the badge. Never rejects.
export function releaseInAppPush() {
  if (!isWavesAdminApp()) return Promise.resolve();
  epoch += 1;
  postToApp({ type: 'clearAlerts' });
  const device = registered;
  registered = null;
  if (!device) return Promise.resolve();
  const release = () => adminFetch('/admin/push/native-unsubscribe', {
    method: 'POST',
    body: { token: device.token },
    headers: { Authorization: `Bearer ${device.auth}` },
  }).catch(() => {});
  return registering.then(release, release);
}

// True when the app took the count, so the caller skips the Badging API.
export function setInAppBadge(count) {
  if (!isWavesAdminApp()) return false;
  const value = Number.isSafeInteger(count) && count > 0 ? count : 0;
  postToApp({ type: 'badge', count: value });
  return true;
}
