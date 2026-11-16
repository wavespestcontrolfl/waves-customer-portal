/**
 * Lock Screen visit card: the web app's side (docs/mobile/live-activity.md).
 *
 * The server starts and updates the card with Apple pushes. To start one on this iPhone it needs the
 * phone's ActivityKit push-to-start token, which only the app can read. This module asks the app's
 * WavesVisitCard plugin for it and posts it to POST /api/push/live-activity-token, where the server keeps
 * it on this phone's own push registration row.
 *
 * The portal bundle also runs in app versions without the plugin, in the Android app and in browsers.
 * There every function here does nothing.
 */
import { Capacitor, registerPlugin } from '@capacitor/core';
import api from '../utils/api';
import { nativePlatform } from './platform';

let plugin;
let listening = false;
// The device token of this phone's push registration, as last given to reportVisitCard. A new start token
// from iOS is posted against it. Cleared at sign-out.
let deviceTokenInUse = null;

function available() {
  try {
    return nativePlatform() === 'ios' && Capacitor.isPluginAvailable('WavesVisitCard');
  } catch {
    return false;
  }
}

// Never await or return this from an async function: a Capacitor plugin proxy has a callable `then`.
function card() {
  plugin ||= registerPlugin('WavesVisitCard');
  return plugin;
}

// iOS can hand the app a new start token at any time. Post it against the registration in use.
async function listenForNewTokens() {
  if (listening) return;
  listening = true;
  try {
    await card().addListener('startToken', () => {
      if (deviceTokenInUse) void reportVisitCard(deviceTokenInUse);
    });
  } catch {
    listening = false;
  }
}

/**
 * Tell the server what it needs to start a card on this iPhone. Call it after this device's push token is
 * registered for the signed-in customer: the server stores the card's token on that registration row, so
 * `deviceToken` is the token posted to /push/native-subscribe.
 *
 * With Live Activities off for the app, or no start token yet, it posts that too, and the server clears
 * what it held. Resolves true when the server stored a start token. Never throws.
 */
export async function reportVisitCard(deviceToken) {
  if (!deviceToken || typeof deviceToken !== 'string' || !available()) return false;
  deviceTokenInUse = deviceToken;
  try {
    await listenForNewTokens();
    const status = await card().status();
    const enabled = Boolean(status?.supported && status?.enabled);
    const res = await api.request('/push/live-activity-token', {
      method: 'POST',
      body: JSON.stringify({
        deviceToken,
        startToken: enabled && typeof status.startToken === 'string' ? status.startToken : null,
        osVersion: typeof status?.osVersion === 'string' ? status.osVersion : undefined,
        enabled,
      }),
    });
    return Boolean(res?.stored);
  } catch (err) {
    console.warn('[visitCard] could not report this phone for the Lock Screen card:', err?.message || err);
    return false;
  }
}

/**
 * Sign-out: end this app's cards at once and stop posting new start tokens. A card listens on an Apple
 * channel, so the server cannot stop one phone; the app must. Never throws.
 */
export async function endVisitCards() {
  deviceTokenInUse = null;
  if (!available()) return false;
  try {
    await card().endAll();
    return true;
  } catch {
    return false;
  }
}
