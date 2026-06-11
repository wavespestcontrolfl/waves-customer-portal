/**
 * Browser-side push subscription helper for the admin portal.
 *
 * Usage:
 *   import { ensurePushSubscription, disablePush, isPushEnabled } from '/push-subscribe.js';
 *   await ensurePushSubscription(); // call from a user gesture (button click)
 */

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBufferEquals(a, b) {
  if (!a || !b) return false;
  const aa = new Uint8Array(a);
  const bb = new Uint8Array(b);
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i++) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}

// iOS detection covers iPad-on-MacIntel where userAgent reports Mac but
// touch points reveal a tablet. Web Push on iOS is gated to Home Screen
// installs (display: standalone) per Apple's iOS 16.4+ rules — both the
// pre-subscribe gate and the denied-permission recovery copy below have
// to branch on this because Safari behavior differs from Chrome/Firefox
// on every other platform.
function isIOS() {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalonePWA() {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function describeDevice() {
  const ua = navigator.userAgent;
  let device = 'Browser';
  if (/iPad/.test(ua)) device = 'iPad';
  else if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/Android/.test(ua)) device = 'Android';
  else if (/Mac/.test(ua)) device = 'Mac';
  else if (/Windows/.test(ua)) device = 'Windows';
  let browser = 'Browser';
  if (/Chrome\//.test(ua) && !/Edg\//.test(ua)) browser = 'Chrome';
  else if (/Safari/.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/Firefox/.test(ua)) browser = 'Firefox';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  return `${device} · ${browser}`;
}

async function getRegistration() {
  if (!('serviceWorker' in navigator)) throw new Error('Service worker not supported in this browser');
  let reg = await navigator.serviceWorker.getRegistration();
  if (!reg) reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return reg;
}

// Per-admin push opt-in registry for THIS browser profile. The browser
// subscription and Notification.permission are shared across every admin
// who signs in here, so the silent self-heal must know WHICH admins
// explicitly enabled push on this browser — otherwise a second admin
// logging in on a shared machine would be silently enrolled (and start
// receiving operational notifications on a device they never opted into).
// Values: true = explicitly enabled, false = explicitly disabled,
// absent = never opted in here (the self-heal does nothing).
const PUSH_OPT_IN_KEY = 'waves_push_admin_opt_ins';

// Local hint only — the payload is read without signature verification,
// which is fine because it gates nothing security-sensitive: the actual
// subscribe call is still authenticated server-side with the same token.
function adminIdFromToken(token) {
  try {
    const raw = token || localStorage.getItem('waves_admin_token');
    if (!raw) return null;
    const payload = JSON.parse(atob(raw.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.technicianId || null;
  } catch { return null; }
}
function readPushOptIns() {
  try { return JSON.parse(localStorage.getItem(PUSH_OPT_IN_KEY)) || {}; } catch { return {}; }
}
function setPushOptIn(token, optedIn) {
  const adminId = adminIdFromToken(token);
  if (!adminId) return;
  try {
    const optIns = readPushOptIns();
    optIns[adminId] = !!optedIn;
    localStorage.setItem(PUSH_OPT_IN_KEY, JSON.stringify(optIns));
  } catch { /* private mode — the self-heal then simply never runs */ }
}
function pushOptInState(token) {
  const adminId = adminIdFromToken(token);
  if (!adminId) return null;
  const v = readPushOptIns()[adminId];
  return v === undefined ? null : !!v;
}

export async function isPushEnabled({ apiBase = '/api', token, verifyServer = false } = {}) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    if (!verifyServer) return true;
    const authToken = token || localStorage.getItem('waves_admin_token');
    const res = await fetch(`${apiBase}/admin/push/subscription-status`, {
      headers: { Authorization: `Bearer ${authToken}` },
    });
    if (!res.ok) return true;
    const status = await res.json();
    return (status.active || 0) > 0;
  } catch { return false; }
}

export async function ensurePushSubscription({ apiBase = '/api', token } = {}) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications are not supported in this browser. Try Chrome, Firefox, Edge, or Safari 16+.');
  }

  // Push requires a secure context (HTTPS or localhost)
  if (!window.isSecureContext) {
    throw new Error('Push requires HTTPS. This page is loaded over HTTP — use the production URL.');
  }

  // iOS gate — Web Push on iPhone/iPad only works for Home Screen apps
  // (iOS 16.4+). Detect upfront so the user gets clear instructions
  // instead of a confusing pushManager.subscribe failure later. Without
  // this pre-check the only iOS hint sits in a generic "Browser refused
  // subscription" error message after the subscribe call has already
  // failed.
  if (isIOS() && !isStandalonePWA()) {
    throw new Error('On iPhone, install Waves Admin to your Home Screen first (tap Share → Add to Home Screen), then open the new icon and try Enable again.');
  }

  // If the user previously blocked notifications, requestPermission
  // resolves immediately as 'denied' without re-prompting. Recovery
  // path is platform-dependent: iOS Home Screen PWAs are managed
  // through Settings → Notifications, not the URL-bar lock icon.
  if (Notification.permission === 'denied') {
    if (isIOS()) {
      throw new Error('Notifications are off for Waves Admin. Open Settings → Notifications → Waves Admin and turn them on. If Waves Admin isn’t listed, remove the Home Screen icon, reinstall from Safari, and grant permission when prompted.');
    }
    throw new Error('Notifications are blocked in your browser. Click the lock/site-info icon in the URL bar → Notifications → Allow, then reload.');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('You did not allow notifications. Click Enable again and choose "Allow" when the browser prompts.');
  }

  const reg = await getRegistration();

  const authToken = token || localStorage.getItem('waves_admin_token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };

  let publicKey;
  try {
    const keyRes = await fetch(`${apiBase}/admin/push/vapid-key`, { headers });
    if (!keyRes.ok) throw new Error(`vapid-key HTTP ${keyRes.status}`);
    publicKey = (await keyRes.json()).publicKey;
  } catch (e) {
    throw new Error(`Could not fetch VAPID key from server: ${e.message}`);
  }
  if (!publicKey) {
    throw new Error('Server returned no VAPID public key. Visit /api/admin/push/diagnostics in your browser (while logged in) to see what env vars the server is actually reading.');
  }

  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub?.options?.applicationServerKey && !arrayBufferEquals(sub.options.applicationServerKey, applicationServerKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey,
      });
    } catch (e) {
      throw new Error(`Browser refused subscription: ${e.message}. (If on iOS, the site must be installed to home screen first.)`);
    }
  }

  const subRes = await fetch(`${apiBase}/admin/push/subscribe`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ subscription: sub.toJSON(), deviceInfo: describeDevice() }),
  });
  if (!subRes.ok) {
    let detail = '';
    try { detail = (await subRes.json()).error || ''; } catch {}
    throw new Error(`Server rejected subscription (HTTP ${subRes.status}). ${detail}`);
  }

  // Record this admin's opt-in for this browser so the silent self-heal
  // is allowed to maintain the subscription from now on.
  setPushOptIn(authToken, true);

  return { ok: true, endpoint: sub.endpoint };
}

/**
 * Silent self-heal for an existing push opt-in. Safe to call on every app
 * load/resume: it never prompts and never throws.
 *
 * Why this exists: iOS Safari rotates or drops push endpoints (PWA
 * reinstall, OS housekeeping), and the server deactivates a subscription
 * row after a 404/410 send failure — but nothing told the client, so the
 * owner had to keep manually re-enabling push. When permission is already
 * granted, re-running the subscribe flow re-creates a dropped browser
 * subscription and re-POSTs it to the server, flipping a deactivated row
 * back to active without any user action.
 */
export async function syncPushSubscription({ apiBase = '/api', token } = {}) {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { ok: false, reason: 'unsupported' };
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
      return { ok: false, reason: 'permission_not_granted' };
    }
    if (isIOS() && !isStandalonePWA()) {
      return { ok: false, reason: 'ios_not_standalone' };
    }
    // Only maintain a subscription THIS admin explicitly enabled on THIS
    // browser. Absent = never opted in here (e.g. a different admin on a
    // shared machine granted permission) — never silently enroll them.
    // false = explicit Disable; the self-heal must not undo it.
    if (pushOptInState(token) !== true) {
      return { ok: false, reason: 'not_opted_in_on_this_browser' };
    }
    // Permission is granted, so ensurePushSubscription will not prompt —
    // requestPermission resolves 'granted' immediately.
    return await ensurePushSubscription({ apiBase, token });
  } catch (e) {
    return { ok: false, reason: e?.message || 'sync_failed' };
  }
}

export async function disablePush({ apiBase = '/api', token } = {}) {
  const authToken = token || localStorage.getItem('waves_admin_token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };

  // Record the opt-out before any network/SW work so the self-heal can't
  // race a partially-completed disable back to enabled.
  setPushOptIn(authToken, false);
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch(`${apiBase}/admin/push/unsubscribe`, {
          method: 'POST', headers,
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
    }
  } catch { /* swallow */ }
  return { ok: true };
}

export async function sendTestPush({ apiBase = '/api', token } = {}) {
  const authToken = token || localStorage.getItem('waves_admin_token');
  const res = await fetch(`${apiBase}/admin/push/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || body.message || `Test push failed (HTTP ${res.status})`);
  }
  return body;
}
