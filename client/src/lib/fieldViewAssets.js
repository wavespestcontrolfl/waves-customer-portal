// Today's files for one build. Field view opens the phone on Today, so an
// open with no signal needs Today's code on the phone, and the service worker
// keeps a file only once the app asked for it (see warmFieldViewLanding in
// fieldView.js). The build writes the list into index.html as JSON in this
// element (vite.config.js). Not as src or href attributes: the service worker
// reads those as the shell's own files and would make every customer's phone
// download Today.
export const FIELD_VIEW_ASSETS_ID = 'field-view-assets';

// The two route modules App.jsx lazy-loads for /admin/today.
export const FIELD_VIEW_MODULES = Object.freeze([
  '/src/pages/admin/TodayShell.jsx',
  '/src/pages/tech/TechHomePage.jsx',
]);

// Build time: the chunk of each module, every chunk it imports statically and
// their CSS, which are the files Vite loads to open the page. Null when the
// bundle has no chunk for a module (a rename): then the page has no list and
// Field view says Today is not ready, rather than claiming it is.
export function fieldViewAssetFiles(bundle, base = '/') {
  const chunks = Object.values(bundle || {}).filter((item) => item?.type === 'chunk');
  const files = new Set();
  const visit = (chunk) => {
    if (!chunk || files.has(chunk.fileName)) return;
    files.add(chunk.fileName);
    for (const css of chunk.viteMetadata?.importedCss || []) files.add(css);
    for (const name of chunk.imports || []) visit(bundle[name]);
  };
  for (const id of FIELD_VIEW_MODULES) {
    const chunk = chunks.find((item) => (item.moduleIds || []).some((moduleId) => moduleId.endsWith(id)));
    if (!chunk) return null;
    visit(chunk);
  }
  return [...files].sort().map((file) => `${base}${file}`);
}

// The build step (vite.config.js). It runs last, when every chunk has its
// final name, and writes this build's list into each page it emits, so a
// page warms the files of the build it runs, never a newer deploy's.
export function fieldViewAssetsPlugin() {
  return {
    name: 'waves-field-view-assets',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const files = fieldViewAssetFiles(ctx?.bundle);
        if (!files) {
          console.warn(`[waves-field-view-assets] no chunk for ${FIELD_VIEW_MODULES.join(' or ')}: Field view will say Today is not ready.`);
          return undefined;
        }
        return [{ tag: 'script', attrs: { type: 'application/json', id: FIELD_VIEW_ASSETS_ID }, children: JSON.stringify(files), injectTo: 'head' }];
      },
    },
  };
}

// Run time: the list this page's own build wrote, or null when the page has
// none (the dev server, or a build that could not list Today).
export function readFieldViewAssets(doc = typeof document === 'undefined' ? null : document) {
  try {
    const list = JSON.parse(doc?.getElementById(FIELD_VIEW_ASSETS_ID)?.textContent || 'null');
    if (!Array.isArray(list) || !list.length) return null;
    return list.every((file) => typeof file === 'string' && file.startsWith('/assets/')) ? list : null;
  } catch {
    return null;
  }
}
