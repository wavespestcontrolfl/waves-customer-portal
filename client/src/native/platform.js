import { Capacitor } from '@capacitor/core';

/**
 * Native-platform helpers shared by the Capacitor integrations
 * (push, biometric lock, camera). `@capacitor/core` is web-safe — these are
 * inert on the web.
 */

/** True only inside the native Capacitor shell (false on the web). */
export function isNativeApp() {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
}

/** Whether a customer (or admin/tech) session JWT is present in localStorage. */
export function hasSessionToken() {
  if (typeof localStorage === 'undefined') return false;
  return Boolean(localStorage.getItem('waves_token') || localStorage.getItem('waves_admin_token'));
}
