// The files of one build that a customer screen can load. The service worker
// opens the customer app from its saved copy at once (public/sw.js,
// freshCompleteCopy), and the server keeps no file of an older build, so the
// copy is only opened first while every one of these files is in the cache.
//
// The list is the entry files (the page and its CSS, with every chunk they
// import) and the whole of the PortalPage chunk's graph: its static imports,
// and every chunk any of them loads lazily (the native-plugin fallbacks).
// The walk never enters the entry chunk again: the router in it lazy-loads
// every staff page, report and link page, and the customer app loads none of
// them. Null when the bundle has no PortalPage chunk (a rename): the build
// then writes no list, and no copy of it is ever opened first.
const PORTAL_PAGE_MODULE = '/src/pages/PortalPage.jsx';
export const CUSTOMER_BUILD_ASSETS_FILE = 'customer-build-assets.json';

export function customerAssetFiles(bundle, base = '/') {
  const chunks = Object.values(bundle || {}).filter((item) => item?.type === 'chunk');
  const portal = chunks.find((item) => (item.moduleIds || []).some((id) => id.endsWith(PORTAL_PAGE_MODULE)));
  const entry = chunks.find((item) => item.isEntry);
  if (!portal || !entry) return null;
  const files = new Set();
  const visit = (chunk, { lazy }) => {
    if (!chunk || files.has(chunk.fileName)) return;
    files.add(chunk.fileName);
    for (const css of chunk.viteMetadata?.importedCss || []) files.add(css);
    for (const name of chunk.imports || []) visit(bundle[name], { lazy });
    if (!lazy) return;
    for (const name of chunk.dynamicImports || []) {
      if (bundle[name] && !bundle[name].isEntry) visit(bundle[name], { lazy });
    }
  };
  visit(entry, { lazy: false });
  visit(portal, { lazy: true });
  return [...files].sort().map((file) => `${base}${file}`);
}

// The build step (vite.config.js). It writes the list beside the build's own
// file list, with a name that ends the same way so the server never caches it.
export function customerBuildAssetsPlugin() {
  return {
    name: 'waves-customer-build-assets',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = customerAssetFiles(bundle);
      if (!files) {
        this.warn(`no chunk for ${PORTAL_PAGE_MODULE}: no copy of this build will open first.`);
        return;
      }
      this.emitFile({ type: 'asset', fileName: CUSTOMER_BUILD_ASSETS_FILE, source: JSON.stringify(files) });
    },
  };
}
