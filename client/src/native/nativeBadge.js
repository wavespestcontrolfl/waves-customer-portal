import { Capacitor, registerPlugin } from '@capacitor/core';
import { nativePlatform } from './platform';

let WavesBadge;
let epoch = 0;
let pending = Promise.resolve(false);

// The portal bundle also runs in older binaries without this local plugin.
// Serialize writes so a slow OS update cannot finish after sign-out's clear.
function writeCount(count, expectedEpoch) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 2147483647) return Promise.resolve(false);
  pending = pending.then(async () => {
    if (expectedEpoch !== epoch || nativePlatform() !== 'ios' || !Capacitor.isPluginAvailable('WavesBadge')) return false;
    WavesBadge ||= registerPlugin('WavesBadge');
    await WavesBadge.setCount({ count });
    return true;
  }).catch(() => false); // Denied badge permission must not break the inbox.
  return pending;
}

// Capture BEFORE fetching. Logout/account changes invalidate even a response
// that lands while native token cleanup still holds the old credentials.
export function captureNativeBadgeUpdate() {
  const expectedEpoch = epoch;
  return (count) => writeCount(count, expectedEpoch);
}

export function clearNativeBadge() {
  return writeCount(0, ++epoch);
}
