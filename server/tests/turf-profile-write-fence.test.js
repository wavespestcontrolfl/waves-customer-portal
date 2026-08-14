// Turf-profile customer-lock fence contract (#3391 GitHub round): FOR UPDATE
// on the turf row cannot serialize the NO-ROW case, so EVERY price-bearing
// customer_turf_profiles insert path must run inside withTurfProfileFence
// (customers row lock first) or the click-to-estimate mint can publish a
// price that ignores a just-entered first profile. This scan keeps future
// writers honest: a new unfenced insert site fails here by name.

const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'migrations', 'tests', '__mocks__'].includes(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

describe('customer_turf_profiles write fence (contract)', () => {
  const serverRoot = path.join(__dirname, '..');
  const insertSites = walk(serverRoot)
    .map((file) => ({ file, src: fs.readFileSync(file, 'utf8') }))
    .filter(({ src }) => /customer_turf_profiles'\)\s*\n?\s*\.insert\(/.test(src));

  test('every insert site takes the shared customer-lock fence', () => {
    expect(insertSites.length).toBeGreaterThanOrEqual(3);
    for (const { file, src } of insertSites) {
      expect({ file: path.relative(serverRoot, file), fenced: src.includes('withTurfProfileFence') })
        .toEqual({ file: path.relative(serverRoot, file), fenced: true });
    }
  });

  test('the fence itself locks the customers row before the write runs', () => {
    const src = fs.readFileSync(path.join(serverRoot, 'services/customer-pricing-ai.js'), 'utf8');
    const fence = src.split('async function withTurfProfileFence')[1].slice(0, 400);
    expect(fence).toMatch(/trx\('customers'\)\.where\(\{ id: customerId \}\)\.forUpdate\(\)/);
  });
});
