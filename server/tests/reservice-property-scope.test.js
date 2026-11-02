/**
 * Re-service asks: the single-premises proof (reservice-property-scope.js) that keeps a customer's texts, calls and
 * emails off a property's report when the account may have another premises. It delegates to the shared fail-closed
 * proof (visit-property-scope.js); these cases pin what reaches it and what never counts as proof. Synthetic data.
 */
const mockOnlyPrimary = jest.fn(async () => true);
jest.mock('../services/service-report/visit-property-scope', () => ({
  customerHasOnlyPrimaryPremises: (...args) => mockOnlyPrimary(...args),
}));

const { accountProvesSinglePremises } = require('../services/reservice-property-scope');

function fakeKnex(customer) {
  return (table) => ({
    where: () => ({ first: async () => (table === 'customers' ? customer : undefined) }),
  });
}
const HOME = { address_line1: '100 Example St', address_line2: null, city: 'Parrish', zip: '34219', has_multi_home: false };

describe('accountProvesSinglePremises', () => {
  beforeEach(() => mockOnlyPrimary.mockClear());

  test('a full primary address hands the shared proof the customer, the primary key and unresolvedFails', async () => {
    const knex = fakeKnex(HOME);
    expect(await accountProvesSinglePremises(knex, 'cust-1')).toBe(true);
    expect(mockOnlyPrimary).toHaveBeenCalledWith(knex, 'cust-1', HOME, expect.any(String), { unresolvedFails: true });
  });

  test('the shared proof saying no (a second premises somewhere) is no', async () => {
    mockOnlyPrimary.mockResolvedValueOnce(false);
    expect(await accountProvesSinglePremises(fakeKnex(HOME), 'cust-1')).toBe(false);
  });

  test.each([
    ['no customer id', null, HOME],
    ['no customer row', 'cust-1', undefined],
    ['no street', 'cust-1', { ...HOME, address_line1: '' }],
    ['a street with no city or zip', 'cust-1', { ...HOME, city: null, zip: null }],
  ])('%s is never proof, and the shared proof is not asked', async (_name, id, customer) => {
    expect(await accountProvesSinglePremises(fakeKnex(customer), id)).toBe(false);
    expect(mockOnlyPrimary).not.toHaveBeenCalled();
  });

  test('a failed read throws (the gather counts it as several premises)', async () => {
    const broken = () => ({ where: () => ({ first: async () => { throw new Error('db down'); } }) });
    await expect(accountProvesSinglePremises(broken, 'cust-1')).rejects.toThrow('db down');
  });
});
