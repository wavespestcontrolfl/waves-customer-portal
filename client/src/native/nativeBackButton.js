/**
 * Android hardware / gesture Back button coordination for the Capacitor shell.
 *
 * bootstrap-android.sh sets android:enableOnBackInvokedCallback="false" so
 * Capacitor 7 delivers back presses to @capacitor/app's 'backButton' event.
 * Listening here lets open dialogs/sheets dismiss cleanly before navigating
 * history or minimizing the app — instead of stranding sheets or abruptly
 * killing the app on a single back swipe.
 *
 * No-op on web and iOS.
 */
import { isNativeApp, nativePlatform } from './platform';

const handlers = [];
let initialized = false;
let listenerHandle = null;

/**
 * Register a LIFO back-button handler. Return true from `handler(event)` to
 * consume the back press; return false/undefined to fall through to the next
 * handler (and ultimately history.back / minimizeApp).
 */
export function registerBackButtonHandler(handler) {
  if (typeof handler !== 'function') return () => {};
  handlers.push(handler);
  return () => {
    const idx = handlers.lastIndexOf(handler);
    if (idx !== -1) handlers.splice(idx, 1);
  };
}

/**
 * Minimize the Android app cleanly (keeping state in Recents), falling back to
 * exitApp() if minimizeApp is unavailable in an older binary.
 */
export async function minimizeOrExitAndroidApp(AppPlugin) {
  let App = AppPlugin;
  if (!App) {
    try {
      ({ App } = await import('@capacitor/app'));
    } catch {
      return;
    }
  }
  try {
    if (typeof App?.minimizeApp === 'function') {
      await App.minimizeApp();
      return;
    }
  } catch { /* fall through to exitApp */ }
  try {
    if (typeof App?.exitApp === 'function') {
      await App.exitApp();
    }
  } catch { /* noop */ }
}

/**
 * Dispatch an Android back-button event through the registered handler stack,
 * then fallback to browser history, then minimize the app.
 */
export async function handleAndroidBackButton(event = {}, AppPlugin = null) {
  // LIFO: the most recently opened dialog / sheet / lock overlay wins first.
  for (let i = handlers.length - 1; i >= 0; i -= 1) {
    try {
      if (handlers[i](event) === true) return 'handled';
    } catch { /* keep walking on handler error */ }
  }

  // Fallback for open accessible dialogs inside child tabs (Reschedule, Cancel,
  // DocumentPreview, etc.) that already handle Escape via useModalFocus.
  if (typeof document !== 'undefined') {
    const openDialogs = Array.from(
      document.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"]'),
    ).filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    if (openDialogs.length > 0) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return 'dialog-escape';
    }
  }

  const canGoBack = Boolean(event?.canGoBack);
  const atPortalHomeRoot = typeof window !== 'undefined'
    && (window.location.pathname === '/' || window.location.pathname === '')
    && !window.location.search;

  if (canGoBack && !atPortalHomeRoot && typeof window !== 'undefined' && typeof window.history?.back === 'function') {
    window.history.back();
    return 'history-back';
  }

  await minimizeOrExitAndroidApp(AppPlugin);
  return 'minimized';
}

export async function initNativeBackButton() {
  if (initialized || !isNativeApp() || nativePlatform() !== 'android') return false;
  initialized = true;
  try {
    const { App } = await import('@capacitor/app');
    listenerHandle = await App.addListener('backButton', (event) => {
      void handleAndroidBackButton(event, App);
    });
    return true;
  } catch {
    initialized = false;
    return false;
  }
}

export function _resetNativeBackButtonForTests() {
  handlers.length = 0;
  initialized = false;
  try { listenerHandle?.remove?.(); } catch { /* noop */ }
  listenerHandle = null;
}
