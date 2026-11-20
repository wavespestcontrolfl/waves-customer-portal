import { lazy } from 'react';
import { isAdminPath } from '../lib/adminBookmarkMeta';
import { isChunkError, isStaleChunkReloadPending } from '../lib/staleChunkReload';
import { PortalReloadPrompt } from './PortalUpdate';

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
  return <div role="status" className="p-4 font-sans text-sm text-zinc-600">Loading the new version...</div>;
}

// Offline, the part's code may be fine and only out of reach. A part that
// loads its code with its own import() shows it too (CustomersPageV2.jsx).
export function MissingPanelCode() {
  const reason = navigator.onLine === false ? 'this device is offline' : 'the portal has a new version';
  return (
    <PortalReloadPrompt
      message={`This part of the page did not load: ${reason}.`}
      className="flex flex-wrap items-center gap-3 rounded-sm border-hairline border-zinc-300 bg-white px-4 py-3 font-sans text-sm text-zinc-900"
    />
  );
}
