// Build time: changes how Vite's preload helper loads a stylesheet. The
// helper marks each file it preloads as seen once it starts to load it, and
// skips a seen file at every later import that lists it: that import neither
// waits for the stylesheet nor learns that it failed. So after a stylesheet
// failed (a deploy removed it, or the device had no signal), a tab that lives
// on, as a held staff tab does (lib/staleChunkReload.js), would render the
// next page that lists it without it, and raise no error. So would a page
// whose import started while the stylesheet was still loading, as after a
// second quick move. Several pages and parts can list one stylesheet:
// Communications, Customers, Dispatch and Schedule all list the pay-growth
// one. With this plugin, an import that lists a stylesheet still loading
// waits for that load, and fails with it. A stylesheet that failed leaves the
// helper's record, and its link stays where it was, marked as failed. The
// next import that lists it loads it again in that place, so a stylesheet
// listed after it still comes after it, as on a fresh load, and its rules
// still win where both set one. While it is still missing, that import fails
// as the first did. An import that does not list it is not touched.
//
// The build stops when Vite's helper no longer has each line this patches,
// or ships without passing through it.

export const PRELOAD_HELPER_ID = '\0vite/preload-helper.js';

// The rel of a failed stylesheet's link: the helper no longer finds it as a
// stylesheet, and the next load of that file takes its place.
const FAILED = 'waves-failed-stylesheet';

// Each line of the helper this patches, and the line that takes its place.
const PATCHES = [
  // An import that lists a stylesheet the helper already loads gets that load.
  [/if \(dep in seen\) return;/g, 'if (dep in seen) return seen[dep];'],
  [/return new Promise\(\(res, rej\) => \{/g, 'return seen[dep] = new Promise((res, rej) => {'],
  // A stylesheet that failed leaves the record; its link stays, marked.
  [
    /link\.addEventListener\(\s*"error",\s*\(\)\s*=>\s*rej\(new Error\(`Unable to preload CSS for \$\{dep\}`\)\)\s*\)/g,
    `link.addEventListener("error", () => { delete seen[dep]; link.rel = "${FAILED}"; rej(new Error(\`Unable to preload CSS for \${dep}\`)); })`,
  ],
  // The next load of a failed stylesheet takes the place of its link.
  [
    /document\.head\.appendChild\(link\);/g,
    `const failed = isCss && document.head.querySelector(\`link[rel="${FAILED}"][href="\${dep}"]\`); failed ? failed.replaceWith(link) : document.head.appendChild(link);`,
  ],
];
const CHANGED = "Vite's preload helper changed: client/src/lib/stylesheetRetry.js cannot patch how it loads a stylesheet.";

// The helper's code with each line patched. Throws unless the code holds the
// `seen` record and each line exactly once.
export function patchStylesheetPreload(code) {
  const changed = !code.includes('const seen = {};') || PATCHES.some(([line]) => (code.match(line) ?? []).length !== 1);
  if (changed) throw new Error(CHANGED);
  return PATCHES.reduce((patched, [line, replacement]) => patched.replace(line, () => replacement), code);
}

export function stylesheetRetryPlugin() {
  let patched = false;
  return {
    name: 'waves-stylesheet-retry',
    apply: 'build',
    transform(code, id) {
      if (id !== PRELOAD_HELPER_ID) return null;
      patched = true;
      return { code: patchStylesheetPreload(code), map: null };
    },
    generateBundle(_options, bundle) {
      const shipped = Object.values(bundle).some((item) => item.type === 'chunk' && item.code.includes('Unable to preload CSS'));
      if (shipped && !patched) this.error(CHANGED);
    },
  };
}
