// Shared, dependency-free allowlist of approved Shopify storefront hosts. Lives in its
// own tiny module so BOTH the adapter (shopify.js, which navigates the origin) and the
// registry (registry.js, which decides a vendor IS a Shopify store) anchor to ONE list —
// they can't drift, and the registry keeps its no-browser-adapter-dependency design (this
// file pulls in nothing). Add a host here when onboarding a new Shopify store.
const SHOPIFY_HOSTS = ['chemicalwarehouse.com', 'seedworldusa.com', 'seedbarn.com', 'gciturfacademy.com', 'intermountainturf.com'];

// True iff `hostname` is an approved storefront host or one of its subdomains. Exact match
// or a dot-anchored suffix only — so a suffix spoof like `chemicalwarehouse.com.evil.com`
// (whose host ENDS with `.evil.com`) is rejected.
function isApprovedShopifyHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return SHOPIFY_HOSTS.some((base) => h === base || h.endsWith(`.${base}`));
}

module.exports = { SHOPIFY_HOSTS, isApprovedShopifyHost };
