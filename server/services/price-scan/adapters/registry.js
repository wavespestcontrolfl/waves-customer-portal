// Adapter selection by vendor host / name. selectAdapterKey is PURE and has no
// dependency on the browser adapter modules, so it stays unit-testable on its
// own; getAdapter lazy-requires the concrete module only when actually scanning.

const HOST_MAP = [
  { test: /domyown\.com|domyown/i, key: 'domyown' },
  { test: /solutionsstores\.com|solutions\s*pest|solutionsstores/i, key: 'solutions' },
  { test: /keystonepestsolutions|keystone\s*pest|keystone/i, key: 'keystone' },
  { test: /veseris\.com|veseris/i, key: 'veseris' },
];

// vendor: { name?, host?, url? }
function selectAdapterKey(vendor = {}) {
  const hay = `${vendor.host || ''} ${vendor.url || ''} ${vendor.name || ''}`.trim();
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
  generic: () => require('./generic'),
};

function getAdapter(key) {
  const load = ADAPTER_LOADERS[key] || ADAPTER_LOADERS.generic;
  return load();
}

module.exports = { selectAdapterKey, getAdapter, HOST_MAP };
