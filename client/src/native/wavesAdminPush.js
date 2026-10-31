// Staff alerts inside Waves Admin, the iOS staff app (ios/WavesPay). Its web
// view cannot run web push or the Badging API, so the app delivers alerts as
// iPhone notifications and sets the icon badge itself.
//
// The signed-in page asks the app for its APNs device token (the app asks the
// staff member for permission first) and registers the token under its own
// staff sign-in, so the app never holds the staff token. The app answers with
// a 'wavesadmin:pushtoken' window event: detail = { token, environment }.

import { adminFetch } from '../lib/adminFetch';
import { isWavesAdminApp } from './platform';

const TOKEN_EVENT = 'wavesadmin:pushtoken';

// Returns a cleanup for sign-out and account switches.
export function registerInAppPush() {
  if (!isWavesAdminApp()) return () => {};
  const onToken = (event) => {
    const { token, environment } = event?.detail || {};
    if (!token) return;
    adminFetch('/admin/push/native-subscribe', { method: 'POST', body: { token, environment } }).catch(() => {});
  };
  window.addEventListener(TOKEN_EVENT, onToken);
  window.webkit.messageHandlers.wavesAdmin.postMessage({ type: 'registerPush' });
  return () => window.removeEventListener(TOKEN_EVENT, onToken);
}

// True when the app took the count, so the caller skips the Badging API.
export function setInAppBadge(count) {
  if (!isWavesAdminApp()) return false;
  const value = Number.isSafeInteger(count) && count > 0 ? count : 0;
  window.webkit.messageHandlers.wavesAdmin.postMessage({ type: 'badge', count: value });
  return true;
}
