/**
 * codex P1 round 2 pre-push (2026-09-24): getCampaignContext's services
 * query filtered on customer_visible alone, which tree_shrub_quarterly
 * keeps true on purpose (20260924020010, for the grandfathered customer's
 * tracking-page summary) — so a campaign could otherwise advertise the
 * retired quarterly program. It must also exclude retired-sale-catalog.js's
 * RETIRED_SALE_SERVICE_KEYS.
 *
 * Separate file from social-content-studio.test.js (which requires the real
 * module with no db mock) so this local ../models/db mock never touches
 * that file's tests.
 */
function chainable(rows) {
  const q = {};
  const passthrough = ['select', 'where', 'whereNotIn', 'limit', 'orderBy'];
  for (const method of passthrough) q[method] = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return q;
}

let servicesQuery;
const mockDb = jest.fn((table) => {
  if (table === 'services') return servicesQuery;
  return chainable([]);
});
mockDb.schema = { hasTable: jest.fn(async (table) => table === 'services') };
jest.mock('../models/db', () => mockDb);

const { getCampaignContext } = require('../services/social-content-studio');
const { RETIRED_SALE_SERVICE_KEYS } = require('../services/pricing-engine/retired-sale-catalog');

describe('getCampaignContext — retired-sale services excluded from campaign facts', () => {
  beforeEach(() => {
    servicesQuery = chainable([
      { id: 1, service_key: 'tree_shrub_program', name: 'Tree & Shrub Care', customer_visible: true },
    ]);
  });

  test('the services query excludes RETIRED_SALE_SERVICE_KEYS (tree_shrub_quarterly)', async () => {
    const context = await getCampaignContext({ topic: '', city: 'Sarasota', service: '' });
    expect(servicesQuery.whereNotIn).toHaveBeenCalledWith('service_key', [...RETIRED_SALE_SERVICE_KEYS]);
    expect(context.services).toEqual([
      { id: 1, service_key: 'tree_shrub_program', name: 'Tree & Shrub Care', customer_visible: true },
    ]);
  });

  test('customer_visible=true is NOT sufficient on its own — tree_shrub_quarterly must be named in RETIRED_SALE_SERVICE_KEYS', () => {
    expect([...RETIRED_SALE_SERVICE_KEYS]).toContain('tree_shrub_quarterly');
  });
});
