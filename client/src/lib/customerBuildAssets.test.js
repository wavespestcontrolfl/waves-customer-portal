import { describe, expect, it, vi } from 'vitest';
import { CUSTOMER_BUILD_ASSETS_FILE, customerAssetFiles, customerBuildAssetsPlugin } from './customerBuildAssets';

// A Rollup output bundle as Vite hands it to generateBundle: the entry (which
// lazy-loads every page, staff pages included), the PortalPage chunk with a
// shared chunk and a lazy native fallback, a staff page, and an asset.
function bundleWith({ portal = true, shared = false, plugins = false } = {}) {
  const chunk = (fileName, moduleId, extra = {}) => ({
    type: 'chunk', fileName, moduleIds: [`/w/client/src/${moduleId}`], facadeModuleId: `/w/client/src/${moduleId}`, imports: [], dynamicImports: [], viteMetadata: { importedCss: new Set() }, ...extra,
  });
  const items = [
    chunk('assets/index-a1.js', 'main.jsx', { isEntry: true, dynamicImports: ['assets/PortalPage-b2.js', 'assets/CustomersPageV2-e5.js', ...(plugins ? ['assets/index-p9.js', 'assets/Library-r1.js'] : [])], viteMetadata: { importedCss: new Set(['assets/index-a1.css']) } }),
    portal && chunk('assets/PortalPage-b2.js', 'pages/PortalPage.jsx', { imports: ['assets/index-a1.js', 'assets/Card-c3.js'], dynamicImports: ['assets/web-d4.js', 'assets/index-a1.js'] }),
    chunk('assets/Card-c3.js', 'components/Card.jsx', { viteMetadata: { importedCss: new Set(['assets/Card-c3.css']) } }),
    chunk('assets/web-d4.js', 'native/web.js'),
    chunk('assets/CustomersPageV2-e5.js', 'pages/admin/CustomersPageV2.jsx', { imports: ['assets/index-a1.js'] }),
    { type: 'asset', fileName: 'assets/logo-f6.png' },
    // The native plugins the entry lazy-loads (a package under node_modules), and a staff
    // component the entry lazy-loads that is not under pages/ (src, so not a plugin).
    plugins && chunk('assets/index-p9.js', '', { facadeModuleId: '/w/node_modules/@capacitor/camera/dist/esm/index.js', moduleIds: ['/w/node_modules/@capacitor/camera/dist/esm/index.js'], dynamicImports: ['assets/web-q0.js'] }),
    plugins && chunk('assets/web-q0.js', '', { facadeModuleId: '/w/node_modules/@capacitor/camera/dist/esm/web.js', moduleIds: ['/w/node_modules/@capacitor/camera/dist/esm/web.js'] }),
    plugins && chunk('assets/Library-r1.js', 'components/staffDocuments/Library.jsx', { imports: ['assets/Staff-s2.js'] }),
    plugins && chunk('assets/Staff-s2.js', 'components/staff/Staff.jsx'),
    // A chunk the entry and PortalPage both import, which lazy-loads one more.
    shared && chunk('assets/Shared-g7.js', 'components/Shared.jsx', { dynamicImports: ['assets/Lazy-h8.js'] }),
    shared && chunk('assets/Lazy-h8.js', 'components/Lazy.jsx', { viteMetadata: { importedCss: new Set(['assets/Lazy-h8.css']) } }),
  ].filter(Boolean);
  return Object.fromEntries(items.map((item) => [item.fileName, item]));
}

describe('customerAssetFiles (the files a customer screen can load)', () => {
  it('lists the entry, the PortalPage chunk, what it imports statically or lazily, and their CSS, and no staff page', () => {
    expect(customerAssetFiles(bundleWith())).toEqual([
      '/assets/Card-c3.css', '/assets/Card-c3.js', '/assets/PortalPage-b2.js', '/assets/index-a1.css', '/assets/index-a1.js', '/assets/web-d4.js',
    ]);
  });

  it('follows the lazy imports of a chunk the entry shares with PortalPage, and still skips the entry\'s own pages', () => {
    const bundle = bundleWith({ shared: true });
    bundle['assets/index-a1.js'].imports = ['assets/Shared-g7.js'];
    bundle['assets/PortalPage-b2.js'].imports = ['assets/index-a1.js', 'assets/Card-c3.js', 'assets/Shared-g7.js'];
    const files = customerAssetFiles(bundle);
    expect(files).toEqual(expect.arrayContaining(['/assets/Shared-g7.js', '/assets/Lazy-h8.js', '/assets/Lazy-h8.css']));
    expect(files).not.toContain('/assets/CustomersPageV2-e5.js');
  });

  it('includes the native plugin chunks the entry lazy-loads and what they load, and no staff component of the entry', () => {
    const files = customerAssetFiles(bundleWith({ plugins: true }));
    expect(files).toEqual(expect.arrayContaining(['/assets/index-p9.js', '/assets/web-q0.js']));
    expect(files).not.toContain('/assets/Library-r1.js');
    expect(files).not.toContain('/assets/Staff-s2.js');
    expect(files).not.toContain('/assets/CustomersPageV2-e5.js');
  });

  it('lists nothing when the build has no PortalPage chunk', () => {
    expect(customerAssetFiles(bundleWith({ portal: false }))).toBeNull();
    expect(customerAssetFiles(undefined)).toBeNull();
  });
});

describe('customerBuildAssetsPlugin (the build step)', () => {
  it('writes the list beside the build file list, under a name the server never caches', () => {
    const emitFile = vi.fn();
    const plugin = customerBuildAssetsPlugin();
    plugin.generateBundle.call({ emitFile, warn: vi.fn() }, {}, bundleWith());
    expect(CUSTOMER_BUILD_ASSETS_FILE.endsWith('build-assets.json')).toBe(true);
    expect(emitFile).toHaveBeenCalledWith({ type: 'asset', fileName: CUSTOMER_BUILD_ASSETS_FILE, source: JSON.stringify(customerAssetFiles(bundleWith())) });
    expect(plugin.apply).toBe('build');
  });

  it('warns and writes no list when it cannot make one', () => {
    const emitFile = vi.fn();
    const warn = vi.fn();
    customerBuildAssetsPlugin().generateBundle.call({ emitFile, warn }, {}, bundleWith({ portal: false }));
    expect(emitFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
