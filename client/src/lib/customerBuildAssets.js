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
// them. The entry also lazy-loads the native plugins (camera, push,
// biometric app lock): those chunks are in the list too. They are told apart
// from the route pages by their source module: a plugin is a package under
// node_modules, and every route page is a module of this app's own src. A
// plugin the app lock needs must be cached, since a failed import there is
// not a missing plugin but a missing file. Null when the bundle has no PortalPage chunk (a rename): the build
// then writes no list, and no copy of it is ever opened first.
const PORTAL_PAGE_MODULE = '/src/pages/PortalPage.jsx';
export const CUSTOMER_BUILD_ASSETS_FILE = 'customer-build-assets.json';

function isPackageChunk(chunk) {
  return /[\\/]node_modules[\\/]/.test(String(chunk.facadeModuleId || ''));
}

export function customerAssetFiles(bundle, base = '/') {
  const chunks = Object.values(bundle || {}).filter((item) => item?.type === 'chunk');
  const portal = chunks.find((item) => (item.moduleIds || []).some((id) => id.endsWith(PORTAL_PAGE_MODULE)));
  const entry = chunks.find((item) => item.isEntry);
  if (!portal || !entry) return null;
  const files = new Set();
  // A chunk is walked once for its static imports and once more for its lazy
  // ones. The entry's walk follows imports only, and a chunk the entry shares
  // with PortalPage must still have its own dynamic imports followed when
  // PortalPage reaches it. A lazy walk covers the static one.
  const staticSeen = new Set();
  const lazySeen = new Set();
  const visit = (chunk, { lazy: wanted }) => {
    // The entry is a boundary: its own lazy imports are every page of the app.
    const lazy = wanted && !chunk?.isEntry;
    if (!chunk || lazySeen.has(chunk.fileName) || (!lazy && staticSeen.has(chunk.fileName))) return;
    (lazy ? lazySeen : staticSeen).add(chunk.fileName);
    files.add(chunk.fileName);
    for (const css of chunk.viteMetadata?.importedCss || []) files.add(css);
    for (const name of chunk.imports || []) visit(bundle[name], { lazy });
    if (!lazy) return;
    for (const name of chunk.dynamicImports || []) {
      if (bundle[name] && !bundle[name].isEntry) visit(bundle[name], { lazy });
    }
  };
  visit(entry, { lazy: false });
  for (const name of entry.dynamicImports || []) {
    const chunk = bundle[name];
    if (chunk && isPackageChunk(chunk)) visit(chunk, { lazy: true });
  }
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
