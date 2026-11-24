/**
 * schedule-estimates: a property-unlinked quote that carries a street is matched to the customer's saved addresses
 * (booking-win "Link it", owner 2026-11-23). The form loads the estimates and the property list at once, so the read
 * ensures the primary property first, as GET /:id/properties does, before it matches. Synthetic data only.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.setTimeout(30000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
const mockOrder = [];
const mockEnsure = jest.fn();
jest.mock('../services/customer-properties', () => ({
  ...jest.requireActual('../services/customer-properties'),
  ensurePrimaryProperty: (...a) => mockEnsure(...a),
}));

const db = require('../models/db');
const { quotedAddressMatchesForEstimates } = require('../routes/admin-customers');

// A property table that holds no rows until ensurePrimaryProperty has run, like a customer with no saved primary.
function installProperties({ created }) {
  let ensured = false;
  mockEnsure.mockReset().mockImplementation(async () => { mockOrder.push('ensure'); ensured = true; return { created: true }; });
  db.mockReset().mockImplementation((table) => {
    if (table !== 'customer_properties') throw new Error(`unexpected table ${table}`);
    const chain = { where: () => chain, select: async () => { mockOrder.push('read'); return ensured ? created : []; } };
    return chain;
  });
}
const quote = (over = {}) => ({ id: 1, property_id: null, address: '12 Test Lane, Bradenton, FL 34205, USA', ...over });
const PRIMARY = { id: 'prop-home', address_line1: '12 Test Lane', address_line2: null, city: 'Bradenton', zip: '34205' };

beforeEach(() => { mockOrder.length = 0; });

describe('quotedAddressMatchesForEstimates', () => {
  test('ensures the primary property before it matches, so a customer with no saved primary yet still matches', async () => {
    installProperties({ created: [PRIMARY] });
    const matches = await quotedAddressMatchesForEstimates('cust-1', [quote()]);
    expect(mockOrder).toEqual(['ensure', 'read']);
    expect(matches.get(1)).toEqual(['prop-home']);
  });

  test('a former address matches nothing; a property-tied or address-free quote is null', async () => {
    installProperties({ created: [PRIMARY] });
    const matches = await quotedAddressMatchesForEstimates('cust-1', [
      quote({ id: 1, address: '500 Old Road, Bradenton, FL 34205' }),
      quote({ id: 2, property_id: 'prop-home' }),
      quote({ id: 3, address: null }),
    ]);
    expect(matches.get(1)).toEqual([]);
    expect(matches.get(2)).toBeNull();
    expect(matches.get(3)).toBeNull();
  });

  test('reads nothing when no quote carries a street of its own', async () => {
    installProperties({ created: [PRIMARY] });
    const matches = await quotedAddressMatchesForEstimates('cust-1', [quote({ address: null }), quote({ id: 2, property_id: 'prop-home' })]);
    expect(mockOrder).toEqual([]);
    expect(matches.size).toBe(0);
  });

  test('a failed property read matches nothing (unknown = not offered)', async () => {
    installProperties({ created: [PRIMARY] });
    db.mockImplementation(() => { throw new Error('db down'); });
    const matches = await quotedAddressMatchesForEstimates('cust-1', [quote()]);
    expect(matches.size).toBe(0);
  });
});
