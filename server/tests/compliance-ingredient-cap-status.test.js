// The staff compliance view reads a stored yearly amount shared by an active ingredient (annual_max_rate, match_type
// 'active_ingredient': the prodiamine caps, Dylox 6.2 G's trichlorfon) through application-limits' own evaluator, so it agrees with
// checkLimits instead of showing status ok and no usage. No database: the evaluator is stubbed.
const applicationLimits = require('../services/application-limits');
const { limitStatusFor } = require('../services/compliance');

const LIMIT = { id: 'l1', product_id: 'p1', product_name: 'Dylox 6.2 G Granular Insecticide', match_type: 'active_ingredient', match_value: 'trichlorfon', limit_type: 'annual_max_rate', limit_value: '9.0700', limit_unit: 'lb/1000sf/year' };
const CTX = { today: '2026-10-09', customerCounty: 'manatee', customerId: 'c1', yearStart: '2026-01-01', lastBefore: new Map(), propertyIds: [] };

describe('compliance limit status: active ingredient yearly amount', () => {
  let spy;
  afterEach(() => spy.mockRestore());
  const stub = (...checks) => {
    spy = jest.spyOn(applicationLimits, 'evaluateActiveIngredientCap');
    checks.forEach((check) => spy.mockResolvedValueOnce(check));
    return spy;
  };

  test('over the cap reads exceeded, with the usage in the row unit, from the customer ledger when there is one lawn', async () => {
    stub({ violated: true, current: 100, max: 100, message: 'x' });
    expect(await limitStatusFor(LIMIT, [], CTX)).toEqual({ status: 'exceeded', current: 9.07 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe(LIMIT);
    expect(spy.mock.calls[0][2]).toMatchObject({ customerId: 'c1', yearStart: '2026-01-01', proposedDate: '2026-10-09T12:00:00Z', propertyId: undefined });
  });

  test('approaching reads warning and under the cap reads ok, with the share used', async () => {
    stub({ approaching: true, current: 66.1, message: 'x' });
    expect(await limitStatusFor(LIMIT, [], CTX)).toEqual({ status: 'warning', current: 5.9953 });
    stub({ violated: false, current: 0, max: 100 });
    expect(await limitStatusFor(LIMIT, [], CTX)).toEqual({ status: 'ok', current: 0 });
  });

  test('a customer with several properties is judged per lawn: the worst one decides', async () => {
    stub({ violated: false, current: 33.3 }, { violated: true, current: 100 });
    expect(await limitStatusFor(LIMIT, [], { ...CTX, propertyIds: ['a', 'b'] })).toEqual({ status: 'exceeded', current: 9.07 });
    expect(spy.mock.calls.map((call) => call[2].propertyId)).toEqual(['a', 'b']);
  });
});
