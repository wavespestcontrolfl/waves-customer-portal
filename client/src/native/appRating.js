import { Capacitor } from '@capacitor/core';
import api from '../utils/api';
import { etDateString } from '../lib/timezone';
import { isNativeApp, nativePlatform } from './platform';

// Store rating pop-up (GATE_APP_RATING_PROMPT, owner 2026-11-02 "do the rating
// for everyone"). Native app only, and only in a build that carries the
// in-app review plugin: the portal bundle also runs in older App Store and
// Play builds, which report the plugin missing and never ask.
//
// The phone keeps two timing rules; the server keeps the finished-visit rule
// and the 120-day spacing (server/services/app-rating-prompt.js):
//   - never on the first day this phone runs the app (that first open already
//     carries the notification permission ask, and both stores want a
//     customer who has used the app);
//   - at most one server check a day.
// Apple and Google draw the card and decide whether it shows; Waves never
// learns what the customer did. Every failure means "do not ask".
const FIRST_DAY_KEY = 'waves_app_rating_first_day';
const CHECKED_DAY_KEY = 'waves_app_rating_checked_day';

function claimDue(today) {
  try {
    const firstDay = localStorage.getItem(FIRST_DAY_KEY);
    if (!firstDay) {
      localStorage.setItem(FIRST_DAY_KEY, today);
      return false;
    }
    if (firstDay >= today || localStorage.getItem(CHECKED_DAY_KEY) === today) return false;
    localStorage.setItem(CHECKED_DAY_KEY, today);
    return true;
  } catch {
    return false; // Storage unavailable: never ask.
  }
}

// stillQuiet: the caller's check that the screen still allows the card (same
// tab, no sheet, unlocked, visible). It runs again after the server answers,
// right before the store is asked, so a sheet opened during the round trip
// is never covered; that claim is then spent until the next 120-day window.
export async function maybeAskForAppRating({ now = new Date(), stillQuiet = () => true } = {}) {
  const platform = isNativeApp() ? nativePlatform() : 'web';
  if (platform !== 'ios' && platform !== 'android') return false;
  if (!Capacitor.isPluginAvailable('InAppReview')) return false;
  if (!claimDue(etDateString(now))) return false;
  try {
    const answer = await api.request('/customer/app-rating/claim', {
      method: 'POST',
      body: JSON.stringify({ platform }),
    });
    if (answer?.ask !== true) return false;
    // Keep the module wrapper: the Capacitor proxy has a callable `then`
    // (nativePush.js), so never resolve a promise with the plugin itself.
    const plugin = await import('@capacitor-community/in-app-review');
    if (!stillQuiet()) return false;
    await plugin.InAppReview.requestReview();
    return true;
  } catch {
    return false;
  }
}
