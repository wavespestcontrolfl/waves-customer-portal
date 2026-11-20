// A recap clip upload (presign, PUT straight to storage, confirm) keeps
// running after its page closes, and the PUT never passes the API write count
// (portalVersion.js). So each upload holds the reload of an out-of-date staff
// tab (reloadHolds.js) from its first step to its last. Used by the schedule's
// RecapCapture and the field page's TechRecapCapture.
import { registerReloadHold } from './reloadHolds';

let uploads = 0;
registerReloadHold('recap-upload', () => uploads > 0);

// Call as an upload starts. Call the returned function when it ends, success
// or failure; a second call does nothing.
export function holdForRecapUpload() {
  uploads += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    uploads -= 1;
  };
}
