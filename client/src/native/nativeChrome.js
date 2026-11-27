/**
 * Native status-bar styling for the Capacitor shell (iOS + Android).
 *
 * The Waves customer shell uses a light sky-blue glass palette (#E5EFF7).
 * Configuring Style.Light ensures dark status-bar icons (clock, signal,
 * battery) remain readable on Android 15/16 edge-to-edge screens and iOS
 * devices — even when the OS is set to Dark Mode.
 *
 * Safe on older installed binaries: checks Capacitor.isPluginAvailable before
 * invoking StatusBar and swallows unavailable errors. No-op on the web.
 */
import { Capacitor } from '@capacitor/core';
import { isNativeApp, nativePlatform } from './platform';

export const CUSTOMER_STATUS_BAR_COLOR = '#E5EFF7';

export async function initNativeChrome() {
  if (!isNativeApp()) return false;
  try {
    if (!Capacitor.isPluginAvailable('StatusBar')) return false;
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // Style.Light = dark text/icons for light backgrounds (Capacitor StatusBar).
    await StatusBar.setStyle({ style: Style.Light });
    if (nativePlatform() === 'android' && typeof StatusBar.setBackgroundColor === 'function') {
      await StatusBar.setBackgroundColor({ color: CUSTOMER_STATUS_BAR_COLOR });
    }
    return true;
  } catch {
    return false;
  }
}
