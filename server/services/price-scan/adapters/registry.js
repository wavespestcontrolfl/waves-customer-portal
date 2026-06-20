// Pure adapter selection by vendor host / name. The concrete adapter modules
// (base, domyown, solutions, keystone, veseris) are wired in PR2 via getAdapter();
// selectAdapterKey is pure so it can be unit-tested without the browser code.

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

module.exports = { selectAdapterKey, HOST_MAP };
