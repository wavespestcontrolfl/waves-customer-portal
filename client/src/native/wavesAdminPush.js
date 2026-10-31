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
//
// Each sign-up carries its own id (`reg`). A release names the sign-up it
// ends, so a late release can never switch off a newer sign-up of the same
// token (the server matches both in one update).

import { adminFetch } from '../lib/adminFetch';
import { isWavesAdminApp } from './platform';

const TOKEN_EVENT = 'wavesadmin:pushtoken';
// This iPhone's sign-up ({ token, reg }). Stored, so a sign-out after a page
// reload still releases it.
const SIGN_UP_KEY = 'waves_admin_push_signup';
const RELEASE_ATTEMPTS = 3;
const MAX_RETRY_MS = 60000;

// The last sign-up and release requests; each new step waits for the one
// before it, so they reach the server in order.
let lastStep = Promise.resolve();
// Bumped by every registerInAppPush and every release: a sign-up retry or a
// token that belongs to an earlier sign-in stops.
let epoch = 0;

function postToApp(message) {
  window.webkit.messageHandlers.wavesAdmin.postMessage(message);
}

function newSignUpId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

// Waits before the next try: longer each time, or less when the connection
// comes back.
function retryDelay(attempt) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      window.removeEventListener('online', done);
      resolve();
    };
    const timer = setTimeout(done, Math.min(attempt * 5000, MAX_RETRY_MS));
    window.addEventListener('online', done);
  });
}

// Returns a cleanup for sign-out and account switches.
export function registerInAppPush() {
  if (!isWavesAdminApp()) return () => {};
  const mine = ++epoch;
  const onToken = (event) => {
    const { token, environment } = event?.detail || {};
    if (mine !== epoch || !token) return;
    const reg = newSignUpId();
    try { localStorage.setItem(SIGN_UP_KEY, JSON.stringify({ token, reg })); } catch { /* storage unavailable */ }
    // Retried while this sign-in lasts: an offline launch registers once the
    // connection is back. A refusal (expired sign-in, bad input) stops.
    const signUp = async () => {
      for (let attempt = 1; mine === epoch; attempt += 1) {
        const response = await adminFetch('/admin/push/native-subscribe', { method: 'POST', body: { token, environment, reg } }).catch(() => null);
        if (response && (response.ok || (response.status < 500 && response.status !== 429))) return;
        await retryDelay(attempt);
      }
    };
    lastStep = lastStep.then(signUp, signUp);
  };
  window.addEventListener(TOKEN_EVENT, onToken);
  postToApp({ type: 'registerPush' });
  return () => {
    window.removeEventListener(TOKEN_EVENT, onToken);
    // Ends this mount's sign-up retries; a newer mount keeps its own.
    if (mine === epoch) epoch += 1;
  };
}

// Every end of a staff session (clearStaffDeviceData: a sign-out button, a
// 401, a forced password change) stops this iPhone's staff alerts. The app
// clears shown alerts and the badge and stops this install's notifications at
// once, so nothing more shows even when the server cannot be reached (APNs
// then answers Unregistered and the server deactivates the row). While the
// sign-in still stands (the buttons call this before the credentials go),
// the server release also runs, after any sign-up in flight, with retries.
// Never rejects.
export function releaseInAppPush() {
  if (!isWavesAdminApp()) return Promise.resolve();
  epoch += 1;
  postToApp({ type: 'signOut' });
  let signUp = null;
  try {
    signUp = JSON.parse(localStorage.getItem(SIGN_UP_KEY) || 'null');
    localStorage.removeItem(SIGN_UP_KEY);
  } catch { /* storage unavailable or unreadable */ }
  const auth = localStorage.getItem('waves_admin_token');
  if (!signUp?.token || !signUp?.reg || !auth) return Promise.resolve();
  const release = async () => {
    for (let attempt = 1; attempt <= RELEASE_ATTEMPTS; attempt += 1) {
      const response = await adminFetch('/admin/push/native-unsubscribe', {
        method: 'POST',
        body: { token: signUp.token, reg: signUp.reg },
        headers: { Authorization: `Bearer ${auth}` },
      }).catch(() => null);
      if (response?.ok) return;
      if (attempt < RELEASE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  };
  lastStep = lastStep.then(release, release);
  return lastStep;
}

// True when the app took the count, so the caller skips the Badging API.
export function setInAppBadge(count) {
  if (!isWavesAdminApp()) return false;
  const value = Number.isSafeInteger(count) && count > 0 ? count : 0;
  postToApp({ type: 'badge', count: value });
  return true;
}
