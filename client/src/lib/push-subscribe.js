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

export async function isPushEnabled() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    const sub = await reg.pushManager.getSubscription();
    return !!sub;
  } catch { return false; }
}

export async function ensurePushSubscription({ apiBase = '/api', token } = {}) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('Push notifications are not supported in this browser');
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permission denied');

  const reg = await getRegistration();

  const authToken = token || localStorage.getItem('waves_admin_token');
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` };

  const keyRes = await fetch(`${apiBase}/admin/push/vapid-key`, { headers });
  const { publicKey } = await keyRes.json();
  if (!publicKey) throw new Error('Server has no VAPID key configured');

  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
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
  return res.json();
}
