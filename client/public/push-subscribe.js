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

// Mirrors the iOS-aware helpers in client/src/lib/push-subscribe.js so
// both helper copies stay in sync. Web Push on iPhone/iPad only works
// for apps installed to the Home Screen (display: standalone) per
// Apple's iOS 16.4+ rules, and the denied-permission recovery path
// differs from desktop browsers — needs to be branched on platform.
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
    throw new Error('Push notifications are not supported in this browser');
  }

  // iOS gate — Web Push on iPhone/iPad only works for Home Screen apps
  // (iOS 16.4+). Detect upfront so the user gets clear instructions
  // instead of a confusing pushManager.subscribe failure later.
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
  if (permission !== 'granted') throw new Error('Permission denied');

  const reg = await getRegistration();

  const authToken = token || localStorage.getItem('waves_admin_token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };

  const keyRes = await fetch(`${apiBase}/admin/push/vapid-key`, { headers });
  const { publicKey } = await keyRes.json();
  if (!publicKey) throw new Error('Server has no VAPID key configured');

  const applicationServerKey = urlBase64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub?.options?.applicationServerKey && !arrayBufferEquals(sub.options.applicationServerKey, applicationServerKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    });
  }

  const subRes = await fetch(`${apiBase}/admin/push/subscribe`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ subscription: sub.toJSON(), deviceInfo: describeDevice() }),
  });
  if (!subRes.ok) throw new Error(`Subscribe failed: ${subRes.status}`);

  return { ok: true, endpoint: sub.endpoint };
}

export async function disablePush({ apiBase = '/api', token } = {}) {
  const authToken = token || localStorage.getItem('waves_admin_token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };

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
