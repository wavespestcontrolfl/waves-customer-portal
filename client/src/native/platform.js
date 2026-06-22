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

/**
 * Whether a customer session JWT is present. Customer-only on purpose — the
 * native shell is the customer app (staff/tech use WavesPay; /admin + /tech are
 * scoped out), so the Face ID lock keys off the customer token only.
 */
export function hasSessionToken() {
  if (typeof localStorage === 'undefined') return false;
  return Boolean(localStorage.getItem('waves_token'));
}
