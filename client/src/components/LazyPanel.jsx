import { lazy } from 'react';
import { isAdminPath } from '../lib/adminBookmarkMeta';
import { browserOffline } from '../lib/portalReload';
import { isChunkError, isStaleChunkReloadPending, missingCodeIsNewVersion } from '../lib/staleChunkReload';
import { PortalReloadPrompt, useNewerBuild } from './PortalUpdate';

// React.lazy for a part of a staff page: a tab, a panel, a sheet. A route's
// page uses App.jsx's lazyWithRetry. When the live build no longer serves the
// part's code and open or held work kept the tab (lib/staleChunkReload.js),
// the part shows a Reload prompt in its place. The rest of the page and the
// staff layout stay, the Ask Waves draft included: a plain React.lazy would
// throw to the boundary around the whole route tree.
export function lazyPanel(factory) {
  return lazy(async () => {
    try {
      const mod = await factory();
      // The stale-chunk reload swallowed the import and is under way.
      if (!mod && isStaleChunkReloadPending()) return { default: PanelPending };
      return mod;
    } catch (err) {
      if (isStaleChunkReloadPending()) return { default: PanelPending };
      if (isChunkError(err) && isAdminPath(window.location.pathname)) return { default: MissingPanelCode };
      throw err;
    }
  });
}

function PanelPending() {
  const label = useNewerBuild() ? 'Loading the new version...' : 'Loading...';
  return <div role="status" className="p-4 font-sans text-sm text-zinc-600">{label}</div>;
}

// It says the portal has a new version only when the server names a newer
// build (missingCodeIsNewVersion). Offline, the part's code may be fine and
// only out of reach; otherwise the cause is unknown. A part that loads its
// code with its own import() shows it too (CustomersPageV2.jsx).
export function MissingPanelCode() {
  const newVersion = missingCodeIsNewVersion(useNewerBuild());
  let message = 'This part of the page did not load. Check your connection and try again.';
  if (browserOffline()) message = 'This part of the page did not load: this device is offline.';
  else if (newVersion) message = 'This part of the page did not load: the portal has a new version.';
  return (
    <PortalReloadPrompt
      message={message}
      className="flex flex-wrap items-center gap-3 rounded-sm border-hairline border-zinc-300 bg-white px-4 py-3 font-sans text-sm text-zinc-900"
    />
  );
}
