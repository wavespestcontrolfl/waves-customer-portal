const {
  clearAllEstimatePricingCache,
  clearEstimatePricingCache,
  estimatePricingCacheKey,
  getEstimatePricingCache,
  setEstimatePricingCache,
} = require('../services/estimate-pricing-cache');

describe('estimate pricing cache', () => {
  beforeEach(() => {
    clearAllEstimatePricingCache();
  });

  test('keys estimate pricing by updated timestamp so reused drafts miss stale entries', () => {
    const staleEstimate = {
      id: 'estimate-1',
      updated_at: '2026-05-15T12:00:00.000Z',
      pricing_version: 'v1',
    };
    const freshEstimate = {
      ...staleEstimate,
      updated_at: '2026-05-15T12:05:00.000Z',
    };

    setEstimatePricingCache(staleEstimate, { frequencies: [{ monthly: 99 }] });

    expect(estimatePricingCacheKey(staleEstimate)).not.toBe(estimatePricingCacheKey(freshEstimate));
    expect(getEstimatePricingCache(staleEstimate)).toEqual({ frequencies: [{ monthly: 99 }] });
    expect(getEstimatePricingCache(freshEstimate)).toBeNull();
  });

  test('clearing by estimate id removes all cached versions', () => {
    setEstimatePricingCache(
      { id: 'estimate-1', updated_at: '2026-05-15T12:00:00.000Z' },
      { version: 'old' },
    );
    setEstimatePricingCache(
      { id: 'estimate-1', updated_at: '2026-05-15T12:05:00.000Z' },
      { version: 'new' },
    );

    clearEstimatePricingCache('estimate-1');

    expect(getEstimatePricingCache({ id: 'estimate-1', updated_at: '2026-05-15T12:00:00.000Z' })).toBeNull();
    expect(getEstimatePricingCache({ id: 'estimate-1', updated_at: '2026-05-15T12:05:00.000Z' })).toBeNull();
  });
});
