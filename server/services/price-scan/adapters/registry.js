// Adapter selection by vendor host / name. selectAdapterKey is PURE and has no
// dependency on the browser adapter modules, so it stays unit-testable on its
// own; getAdapter lazy-requires the concrete module only when actually scanning.
// (shopify-hosts is a zero-dependency allowlist, not a browser adapter — importing
// it keeps that purity while sharing ONE Shopify allowlist with the adapter.)
const { isApprovedShopifyHost } = require('./shopify-hosts');

const HOST_MAP = [
  { test: /domyown\.com|domyown/i, key: 'domyown' },
  { test: /solutionsstores\.com|solutions\s*pest|solutionsstores/i, key: 'solutions' },
  { test: /keystonepestsolutions|keystone\s*pest|keystone/i, key: 'keystone' },
  { test: /veseris\.com|veseris/i, key: 'veseris' },
];

// The parsed hostname of a vendor-supplied location string (accepts a scheme-less host by
// assuming https), or '' if unparseable. Used to anchor Shopify routing to a real host
// rather than a substring of operator-editable text.
function hostOf(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  try { return new URL(s).hostname.toLowerCase(); } catch (e) { /* maybe scheme-less */ }
  try { return new URL(`https://${s}`).hostname.toLowerCase(); } catch (e) { return ''; }
}

// A vendor is a Shopify store only when one of its LOCATION fields parses to an allowlisted
// host. Anchored to the parsed hostname (not a raw substring of host/url/website/name) so a
// userinfo/suffix spoof — chemicalwarehouse.com@127.0.0.1, chemicalwarehouse.com.evil.com —
// is NOT routed to the Shopify scraper (which would navigate that origin). The adapter's
// baseOrigin fail-closes on the same allowlist too; this is the matching first layer. The
// vendor `name` is intentionally excluded — a display name must never select a scraper that
// navigates a URL.
function isShopifyVendor(vendor) {
  return [vendor.host, vendor.url, vendor.website].some((src) => {
    const h = hostOf(src);
    return !!h && isApprovedShopifyHost(h);
  });
}

// vendor: { name?, host?, url?, website? }
function selectAdapterKey(vendor = {}) {
  if (isShopifyVendor(vendor)) return 'shopify';
  const hay = `${vendor.host || ''} ${vendor.url || ''} ${vendor.website || ''} ${vendor.name || ''}`.trim();
  if (!hay) return 'generic';
  for (const { test, key } of HOST_MAP) if (test.test(hay)) return key;
  return 'generic';
}

// Lazy so requiring the registry (and selectAdapterKey) never pulls in the
// Playwright-shaped adapter modules.
const ADAPTER_LOADERS = {
  domyown: () => require('./domyown'),
  solutions: () => require('./solutions'),
  keystone: () => require('./keystone'),
  veseris: () => require('./veseris'), // B2B login adapter (account pricing)
  shopify: () => require('./shopify'), // generic Shopify storefront (base URL from vendor.website)
  generic: () => require('./generic'),
};

function getAdapter(key) {
  const load = ADAPTER_LOADERS[key] || ADAPTER_LOADERS.generic;
  return load();
}

module.exports = { selectAdapterKey, getAdapter, HOST_MAP };
