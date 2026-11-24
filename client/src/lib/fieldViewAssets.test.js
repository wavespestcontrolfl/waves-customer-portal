// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIELD_VIEW_ASSETS_ID, fieldViewAssetFiles, fieldViewAssetsPlugin, readFieldViewAssets } from './fieldViewAssets';

// A Rollup output bundle as Vite hands it to the last HTML step: Today's two
// route chunks, a chunk they share with its own CSS, the entry, and a page
// Field view never opens.
function bundleWith({ techHome = true } = {}) {
  const chunk = (fileName, moduleId, { imports = [], css = [] } = {}) => ({
    type: 'chunk', fileName, moduleIds: [`/w/client/src/${moduleId}`], imports, viteMetadata: { importedCss: new Set(css) },
  });
  const items = [
    chunk('assets/index-a1.js', 'main.jsx', { css: ['assets/index-a1.css'] }),
    chunk('assets/TodayShell-b2.js', 'pages/admin/TodayShell.jsx', { imports: ['assets/index-a1.js', 'assets/TechFieldShell-c3.js'] }),
    chunk('assets/TechFieldShell-c3.js', 'components/tech/TechFieldShell.jsx', { css: ['assets/TechFieldShell-c3.css'] }),
    techHome && chunk('assets/TechHomePage-d4.js', 'pages/tech/TechHomePage.jsx', { imports: ['assets/TechFieldShell-c3.js'], css: ['assets/TechHomePage-d4.css'] }),
    chunk('assets/CustomersPageV2-e5.js', 'pages/admin/CustomersPageV2.jsx', { imports: ['assets/index-a1.js'], css: ['assets/CustomersPageV2-e5.css'] }),
    { type: 'asset', fileName: 'assets/logo-f6.png' },
  ].filter(Boolean);
  return Object.fromEntries(items.map((item) => [item.fileName, item]));
}

describe("fieldViewAssetFiles (Today's files in one build)", () => {
  it("lists Today's two chunks, every chunk they import and their CSS, and no other page", () => {
    expect(fieldViewAssetFiles(bundleWith())).toEqual([
      '/assets/TechFieldShell-c3.css', '/assets/TechFieldShell-c3.js', '/assets/TechHomePage-d4.css', '/assets/TechHomePage-d4.js',
      '/assets/TodayShell-b2.js', '/assets/index-a1.css', '/assets/index-a1.js',
    ]);
  });

  it('lists nothing when the build has no chunk for one of the two modules', () => {
    expect(fieldViewAssetFiles(bundleWith({ techHome: false }))).toBeNull();
    expect(fieldViewAssetFiles(undefined)).toBeNull();
  });
});

describe('fieldViewAssetsPlugin (the build step)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("writes this build's list into the page as JSON", () => {
    const tags = fieldViewAssetsPlugin().transformIndexHtml.handler('<html></html>', { bundle: bundleWith() });
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ tag: 'script', attrs: { type: 'application/json', id: FIELD_VIEW_ASSETS_ID }, injectTo: 'head' });
    expect(JSON.parse(tags[0].children)).toEqual(fieldViewAssetFiles(bundleWith()));
  });

  it('runs last, in a build only, and warns instead of writing a list it could not make', () => {
    const plugin = fieldViewAssetsPlugin();
    expect(plugin.apply).toBe('build');
    expect(plugin.transformIndexHtml.order).toBe('post');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(plugin.transformIndexHtml.handler('<html></html>', { bundle: bundleWith({ techHome: false }) })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('readFieldViewAssets (the page reads its own build list)', () => {
  const write = (text) => {
    const element = document.createElement('script');
    element.type = 'application/json';
    element.id = FIELD_VIEW_ASSETS_ID;
    element.textContent = text;
    document.head.appendChild(element);
  };
  afterEach(() => { document.getElementById(FIELD_VIEW_ASSETS_ID)?.remove(); });

  it('reads the list the build wrote', () => {
    write(JSON.stringify(['/assets/TodayShell-b2.js', '/assets/TechHomePage-d4.css']));
    expect(readFieldViewAssets()).toEqual(['/assets/TodayShell-b2.js', '/assets/TechHomePage-d4.css']);
  });

  it('reads no list on the dev server, from bad JSON, an empty list or a file outside /assets/', () => {
    expect(readFieldViewAssets()).toBeNull();
    for (const text of ['{not json', '[]', '{"files": ["/assets/a.js"]}', '["/assets/a.js", "https://elsewhere.example/b.js"]']) {
      document.getElementById(FIELD_VIEW_ASSETS_ID)?.remove();
      write(text);
      expect(readFieldViewAssets()).toBeNull();
    }
  });
});
