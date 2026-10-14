const PriceReadBack = require('../services/intelligence-bar/price-read-back');

describe('price read-back record', () => {
  const key = { actorId: 'admin-1', customerId: 'c1', statedPrice: 60.33 };
  beforeEach(() => PriceReadBack._resetForTests());

  test('no record: never confirmed', () => {
    expect(PriceReadBack.isConfirmed({ ...key, catalogPrice: 61.33, requestStartedAt: 2000 })).toBe(false);
  });

  test('the same request never confirms its own read-back; a later one does', () => {
    PriceReadBack.recordReadBack({ ...key, catalogPrice: 61.33, requestStartedAt: 1000 });
    expect(PriceReadBack.isConfirmed({ ...key, catalogPrice: 61.33, requestStartedAt: 1000 })).toBe(false);
    expect(PriceReadBack.isConfirmed({ ...key, catalogPrice: 61.33, requestStartedAt: 2000 })).toBe(true);
  });

  test('another operator, customer, stated price or catalog price does not confirm', () => {
    PriceReadBack.recordReadBack({ ...key, catalogPrice: 61.33, requestStartedAt: 1000 });
    expect(PriceReadBack.isConfirmed({ ...key, actorId: 'admin-2', catalogPrice: 61.33, requestStartedAt: 2000 })).toBe(false);
    expect(PriceReadBack.isConfirmed({ ...key, customerId: 'c2', catalogPrice: 61.33, requestStartedAt: 2000 })).toBe(false);
    expect(PriceReadBack.isConfirmed({ ...key, statedPrice: 55, catalogPrice: 61.33, requestStartedAt: 2000 })).toBe(false);
    expect(PriceReadBack.isConfirmed({ ...key, catalogPrice: 70, requestStartedAt: 2000 })).toBe(false);
  });

  test('a stale record or an unordered request never confirms; clear() uses it up', () => {
    PriceReadBack.recordReadBack({ ...key, catalogPrice: 61.33, requestStartedAt: 1000, now: 1000 });
    expect(PriceReadBack.isConfirmed({ ...key, catalogPrice: 61.33, requestStartedAt: 2000, now: 1000 + PriceReadBack.TTL_MS + 1 })).toBe(false);
    expect(PriceReadBack.isConfirmed({ ...key, catalogPrice: 61.33, requestStartedAt: null, now: 1500 })).toBe(false);
    expect(PriceReadBack.isConfirmed({ ...key, catalogPrice: 61.33, requestStartedAt: 2000, now: 1500 })).toBe(true);
    PriceReadBack.clear(key);
    expect(PriceReadBack.isConfirmed({ ...key, catalogPrice: 61.33, requestStartedAt: 2000, now: 1500 })).toBe(false);
  });
});
