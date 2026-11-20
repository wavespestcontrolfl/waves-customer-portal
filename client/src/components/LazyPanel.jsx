import { lazy } from 'react';
import { isChunkError, isStaleChunkReloadPending, missingCodeIsNewVersion, staffTab } from '../lib/staleChunkReload';
import { PortalReloadPrompt, useBrowserOffline, useNewerBuild } from './PortalUpdate';
import { Button, Dialog, DialogBody, DialogFooter } from './ui';

// React.lazy for a part of a staff page: a tab, a panel, a sheet. A route's
// page uses App.jsx's lazyWithRetry. When the live build no longer serves the
// part's code on a staff tab, the stale-chunk handler leaves its import to
// fail (lib/staleChunkReload.js), and the part shows a Reload prompt in its
// place. It never reloads by itself: the page around it can hold unsaved
// work. The rest of the page and the staff layout stay, the Ask Waves draft
// included: a plain React.lazy would throw to the boundary around the whole
// route tree.
// `dialog`: the name of the dialog that a part draws itself, such as Today's
// job card. Its prompt then shows in a dialog of that name. In the part's
// place, the prompt would sit where the part is in the page, out of view and
// with no way to close it. The dialog's Close calls the part's own `onClose`
// and never reloads.
export function lazyPanel(factory, { dialog } = {}) {
  const Missing = dialog ? missingPanelDialog(dialog) : MissingPanelCode;
  return lazy(async () => {
    try {
      const mod = await factory();
      // The stale-chunk handler swallowed the import: its reload is under
      // way, or an app link is opening the next page (markPageNavigating).
      if (!mod && isStaleChunkReloadPending()) return { default: PanelPending };
      return mod;
    } catch (err) {
      // A reload is under way, such as the one a page whose code is missing
      // started (App.jsx): the part shows the loading line until it lands.
      if (isStaleChunkReloadPending()) return { default: PanelPending };
      if (isChunkError(err) && staffTab()) return { default: Missing };
      throw err;
    }
  });
}

function missingPanelDialog(name) {
  return function MissingPanelDialog({ onClose }) {
    return (
      <Dialog open onClose={onClose} size="sm" aria-label={name}>
        <DialogBody>
          <MissingPanelCode />
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" className="min-h-11" onClick={onClose}>Close</Button>
        </DialogFooter>
      </Dialog>
    );
  };
}

function PanelPending() {
  const label = useNewerBuild() ? 'Loading the new version...' : 'Loading...';
  return <div role="status" className="p-4 font-sans text-sm text-zinc-600">{label}</div>;
}

// It says the portal has a new version only when the server names a newer
// build (missingCodeIsNewVersion). Offline, the part's code may be fine and
// only out of reach; otherwise the cause is unknown. The text follows both
// while it shows. A part that loads its code with its own import() shows it
// too (CustomersPageV2.jsx).
export function MissingPanelCode() {
  const offline = useBrowserOffline();
  const newVersion = missingCodeIsNewVersion(useNewerBuild(), offline);
  let message = 'This part of the page did not load. Check your connection and try again.';
  if (offline) message = 'This part of the page did not load: this device is offline.';
  else if (newVersion) message = 'This part of the page did not load: the portal has a new version.';
  return (
    <PortalReloadPrompt
      message={message}
      className="flex flex-wrap items-center gap-3 rounded-sm border-hairline border-zinc-300 bg-white px-4 py-3 font-sans text-sm text-zinc-900"
    />
  );
}
