const mockLookupByParcel = jest.fn();
const mockLookupParcelByPoint = jest.fn();
const mockTriggerNotification = jest.fn();

jest.mock('../services/property-lookup/ai-property-lookup', () => ({
  lookupPropertyFromCountyByParcel: (...args) => mockLookupByParcel(...args),
}));
jest.mock('../services/property-lookup/parcel-gis', () => ({
  lookupParcelByPoint: (...args) => mockLookupParcelByPoint(...args),
}));
jest.mock('../services/notification-triggers', () => ({
  triggerNotification: (...args) => mockTriggerNotification(...args),
}));
jest.mock('../utils/cron-lock', () => ({
  runExclusive: (jobName, fn) => fn(),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const {
  runPropertyLookupCanary,
  _private: { GOLDEN_PARCELS, evaluateGoldenRecord },
} = require('../services/property-lookup-canary');

function healthyRecord() {
  return {
    squareFootage: 2200,
    lotSize: 9000,
    yearBuilt: 2022,
    hasPool: true,
    poolCageSqft: 1066,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PROPERTY_LOOKUP_CANARY_DISABLED;
  mockLookupParcelByPoint.mockResolvedValue({ county: 'Manatee', paoParcelId: '579642409' });
  mockLookupByParcel.mockResolvedValue(healthyRecord());
});

describe('evaluateGoldenRecord', () => {
  it('passes a fully parsed record', () => {
    expect(evaluateGoldenRecord('X', healthyRecord())).toEqual([]);
  });

  it('names the surface that stopped parsing', () => {
    expect(evaluateGoldenRecord('X', null)).toEqual(['X: by-parcel lookup returned no record']);
    expect(evaluateGoldenRecord('X', { ...healthyRecord(), hasPool: null }))
      .toEqual(['X: pool not found on extra-features roll']);
    expect(evaluateGoldenRecord('X', { ...healthyRecord(), squareFootage: 0, poolCageSqft: null }))
      .toEqual(['X: squareFootage not parsed', 'X: screen cage sqft not parsed']);
  });

  it('labels never carry parcel IDs or addresses (PII rule)', () => {
    for (const golden of GOLDEN_PARCELS) {
      const failures = evaluateGoldenRecord(golden.label, null);
      const text = failures.join(' ');
      expect(text).not.toContain(golden.parcel.paoParcelId);
      expect(text).not.toContain(golden.parcel.situsAddress);
    }
  });
});

describe('runPropertyLookupCanary', () => {
  it('healthy run checks all goldens + FDOR and fires nothing', async () => {
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(GOLDEN_PARCELS.length + 1);
    expect(mockLookupByParcel).toHaveBeenCalledTimes(GOLDEN_PARCELS.length);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  it('a broken county fires the canary notification with the county named', async () => {
    mockLookupByParcel.mockImplementation(async (parcel) => (
      parcel.county === 'Sarasota' ? null : healthyRecord()
    ));
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(false);
    expect(mockTriggerNotification).toHaveBeenCalledWith('property_lookup_canary_failed', {
      failures: ['Sarasota golden parcel: by-parcel lookup returned no record'],
    });
  });

  it('a degraded parse (pool gone tri-state-unknown) is a failure, not a pass', async () => {
    mockLookupByParcel.mockResolvedValue({ ...healthyRecord(), hasPool: null, poolCageSqft: null });
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBe(GOLDEN_PARCELS.length * 2);
  });

  it('an FDOR layer miss fails even when the county parsers are green', async () => {
    mockLookupParcelByPoint.mockResolvedValue(null);
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['FDOR cadastral layer: golden point no longer resolves to a parcel']);
  });

  it('a wrong PAO parcel id from FDOR is a failure (normalization drift)', async () => {
    mockLookupParcelByPoint.mockResolvedValue({ county: 'Manatee', paoParcelId: '0579642409' });
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['FDOR cadastral layer: golden point resolves to the wrong PAO parcel id']);
  });

  it('lookup rejections degrade to failures instead of throwing', async () => {
    mockLookupParcelByPoint.mockRejectedValue(new Error('arcgis down'));
    mockLookupByParcel.mockRejectedValue(new Error('county down'));
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBe(1 + GOLDEN_PARCELS.length);
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
  });

  it('a thrown lookup is labeled distinctly from a clean no-record null', async () => {
    const timeoutErr = new Error('connect ETIMEDOUT https://sc-pa.com/parcel/0069140016');
    timeoutErr.code = 'ETIMEDOUT';
    mockLookupByParcel.mockImplementation(async (parcel) => {
      if (parcel.county === 'Sarasota') throw timeoutErr;
      if (parcel.county === 'Charlotte') return null;
      return healthyRecord();
    });
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('Sarasota golden parcel: by-parcel lookup threw (ETIMEDOUT)');
    expect(result.failures).toContain('Charlotte golden parcel: by-parcel lookup returned no record');
  });

  it('throw labels carry only the error code — never the URL/parcel from err.message', async () => {
    const err = new Error('request to https://sc-pa.com/parcel/0069140016 failed');
    err.code = 'ECONNRESET';
    mockLookupByParcel.mockImplementation(async (parcel) => {
      if (parcel.county === 'Sarasota') throw err;
      return healthyRecord();
    });
    const result = await runPropertyLookupCanary();
    const text = result.failures.join(' ');
    expect(text).toContain('(ECONNRESET)');
    expect(text).not.toContain('0069140016');
    expect(text).not.toContain('sc-pa.com');
  });

  it('a codeless thrown error falls back to the network/timeout label', async () => {
    mockLookupParcelByPoint.mockRejectedValue(new TypeError('fetch failed'));
    const result = await runPropertyLookupCanary();
    expect(result.failures).toContain('FDOR cadastral layer: golden point lookup threw (TypeError)');
  });

  it('kill switch skips without touching the network', async () => {
    process.env.PROPERTY_LOOKUP_CANARY_DISABLED = '1';
    const result = await runPropertyLookupCanary();
    expect(result.skipped).toBe(true);
    expect(mockLookupByParcel).not.toHaveBeenCalled();
    expect(mockLookupParcelByPoint).not.toHaveBeenCalled();
  });
});

describe('notification trigger registration', () => {
  it('property_lookup_canary_failed builds a bounded admin notification', () => {
    const { TRIGGER_REGISTRY } = jest.requireActual('../services/notification-triggers');
    const trigger = TRIGGER_REGISTRY.property_lookup_canary_failed;
    expect(trigger).toBeDefined();
    expect(trigger.category).toBe('system');

    const built = trigger.build({
      failures: ['Manatee golden parcel: squareFootage not parsed', 'b', 'c', 'd'],
    });
    expect(built.title).toContain('canary');
    expect(built.body).toContain('4 check(s) failing');
    expect(built.body.length).toBeLessThanOrEqual(220);

    // Defensive build with no payload.
    expect(trigger.build({}).body).toContain('0 check(s) failing');
  });
});
