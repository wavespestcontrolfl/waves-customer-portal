import { useEffect } from 'react';
import { trackAdminPageView } from '../lib/adminUsage';

/**
 * Report the subview a page ACTUALLY rendered — fallbacks and role gates
 * resolved — superseding the layout's raw ?tab= beacon, so an invalid or
 * unauthorized deep link never records a tab the user did not see
 * (Codex #2961 r14/r15).
 *
 * Contract: the page's pageKey MUST be listed in SELF_REPORTING_PAGES
 * (lib/adminUsage.js) so its raw route beacon waits out the page's lazy
 * chunk instead of flushing first. Pass the page's query object (or other
 * invalidation values) as extraDeps — constant length per call site — so a
 * query-only change that does NOT move the resolved tab (another bad deep
 * link) still re-asserts the rendered leaf; the lib dedupes re-assertions.
 */
export default function useRenderedTabBeacon(pathname, renderedTab, extraDeps = []) {
  useEffect(() => {
    // Falsy leaf = "not mine to report right now" — a hub deferring to the
    // embedded child that owns the deeper leaf (ServiceLibrary → protocol
    // command center), a child rendered outside its tracked route, or a
    // state value that matches no rendered panel. The raw route beacon
    // remains the fallback record in that case.
    if (!renderedTab) return;
    trackAdminPageView({
      pathname,
      search: `?tab=${renderedTab}`,
      authoritative: true,
    });
  }, [pathname, renderedTab, ...extraDeps]);
}
