// A recap clip upload (presign, PUT straight to storage, confirm) keeps
// running after its page closes, and the PUT never passes the API write count
// (portalVersion.js). So each upload holds the reload of an out-of-date staff
// tab (reloadHolds.js) from its first step to its last. A picked clip that
// waits for its tag holds it too: until then the clip is only in the page.
// So does a field clip whose upload failed, while it waits for Retry or
// Discard. Used by the schedule's RecapCapture and the field page's
// TechRecapCapture.
import { useEffect } from 'react';
import { registerReloadHold } from './reloadHolds';

let uploads = 0;
// Mounted recovery stores of TechRecapCapture, with the number of components
// that mount each.
const recoveryStores = new Map();
registerReloadHold('recap-upload', () => uploads > 0
  || [...recoveryStores.keys()].some((store) => store.failedDrafts.size > 0));

// Call as an upload starts, or as a picked clip waits for its tag. Call the
// returned function when it ends, success or failure; a second call does
// nothing.
export function holdForRecapUpload() {
  uploads += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    uploads -= 1;
  };
}

// A field clip whose upload failed waits in its recovery store
// (TechRecapCapture) for Retry or Discard. Its copy on the device is best
// effort, so the store holds the reload while it has one. Call from each
// component that mounts the store.
export function useRecapRecoveryHold(store) {
  useEffect(() => {
    recoveryStores.set(store, (recoveryStores.get(store) || 0) + 1);
    return () => {
      const mounts = recoveryStores.get(store) - 1;
      if (mounts > 0) recoveryStores.set(store, mounts);
      else recoveryStores.delete(store);
    };
  }, [store]);
}
