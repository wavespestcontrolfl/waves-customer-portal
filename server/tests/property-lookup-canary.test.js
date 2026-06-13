const mockLookupByParcel = jest.fn();
const mockLookupParcelByPoint = jest.fn();
const mockTriggerNotification = jest.fn();

// In-memory stand-in for the property_lookup_canary_state table so the
// consecutive-failure escalation can be exercised across simulated nights.
const mockCanaryStore = new Map();

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
jest.mock('../models/db', () => {
  function qb() {
    let whereInVals = null;
    let pendingInsert = null;
    const builder = {
      whereIn(_col, vals) { whereInVals = vals; return builder; },
      select() {
        const keys = whereInVals || [...mockCanaryStore.keys()];
        return Promise.resolve(keys.map((k) => mockCanaryStore.get(k)).filter(Boolean));
      },
      insert(row) { pendingInsert = row; return builder; },
      onConflict() { return builder; },
      merge() {
        if (pendingInsert) mockCanaryStore.set(pendingInsert.check_key, { ...pendingInsert });
        return Promise.resolve([]);
      },
    };
    return builder;
  }
  qb.fn = { now: () => 'NOW()' };
  qb.raw = (s) => ({ __raw: s });
  return qb;
});

const {
  runPropertyLookupCanary,
  _private: {
    GOLDEN_PARCELS,
    evaluateGoldenRecord, errLabel, atAlertPoint, decideCanaryAlert,
  },
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

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  e.code = 20;
  return e;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCanaryStore.clear();
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

describe('errLabel', () => {
  it('collapses every abort spelling to a readable "timeout"', () => {
    // AbortController fetch timeout: a DOMException named AbortError whose
    // legacy numeric code is 20 — the case that rendered as an opaque "(20)".
    expect(errLabel({ name: 'AbortError', code: 20 })).toBe('timeout');
    expect(errLabel({ code: 'ABORT_ERR' })).toBe('timeout');
    expect(errLabel({ name: 'AbortError' })).toBe('timeout');
  });

  it('keeps other error codes verbatim', () => {
    expect(errLabel({ code: 'ETIMEDOUT' })).toBe('ETIMEDOUT');
    expect(errLabel({ code: 'ECONNRESET' })).toBe('ECONNRESET');
    expect(errLabel(new TypeError('fetch failed'))).toBe('TypeError');
    expect(errLabel(null)).toBe('network/timeout');
  });
});

describe('atAlertPoint', () => {
  it('fires at the threshold and weekly thereafter, silent in between', () => {
    expect(atAlertPoint(1, 3)).toBe(false);
    expect(atAlertPoint(2, 3)).toBe(false);
    expect(atAlertPoint(3, 3)).toBe(true);  // first crossing
    expect(atAlertPoint(4, 3)).toBe(false);
    expect(atAlertPoint(9, 3)).toBe(false);
    expect(atAlertPoint(10, 3)).toBe(true); // +7 weekly re-ping
    expect(atAlertPoint(17, 3)).toBe(true);
  });
});

describe('decideCanaryAlert', () => {
  const transientCheck = {
    key: 'golden:Sarasota', status: 'transient',
    details: ['Sarasota golden parcel: by-parcel lookup threw (timeout)'],
  };

  it('suppresses a first-night transient and escalates once it crosses the threshold', () => {
    const n1 = decideCanaryAlert([transientCheck], {});
    expect(n1.alertFailures).toEqual([]);
    expect(n1.suppressed).toEqual(['Sarasota golden parcel: by-parcel lookup threw (timeout) (night 1/3)']);
    expect(n1.nextCounts).toEqual({ 'golden:Sarasota': 1 });

    const n3 = decideCanaryAlert([transientCheck], { 'golden:Sarasota': 2 });
    expect(n3.alertFailures).toEqual(['Sarasota golden parcel: by-parcel lookup threw (timeout) — 3 nights running']);
    expect(n3.suppressed).toEqual([]);
    expect(n3.nextCounts).toEqual({ 'golden:Sarasota': 3 });
  });

  it('alerts a regression immediately and resets its streak', () => {
    const r = decideCanaryAlert([{
      key: 'golden:Sarasota', status: 'regression',
      details: ['Sarasota golden parcel: pool not found on extra-features roll'],
    }], { 'golden:Sarasota': 5 });
    expect(r.alertFailures).toEqual(['Sarasota golden parcel: pool not found on extra-features roll']);
    expect(r.nextCounts).toEqual({ 'golden:Sarasota': 0 });
  });

  it('an ok check clears its counter and says nothing', () => {
    const r = decideCanaryAlert([{ key: 'golden:Manatee', status: 'ok', details: [] }], { 'golden:Manatee': 4 });
    expect(r.alertFailures).toEqual([]);
    expect(r.suppressed).toEqual([]);
    expect(r.nextCounts).toEqual({ 'golden:Manatee': 0 });
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

  it('a transient failure stays silent for 2 nights, then pages on the 3rd', async () => {
    mockLookupByParcel.mockImplementation(async (parcel) => {
      if (parcel.county === 'Sarasota') throw abortError();
      return healthyRecord();
    });

    const n1 = await runPropertyLookupCanary();
    expect(n1.ok).toBe(true);
    expect(n1.failures).toEqual([]);
    expect(n1.suppressed.some((s) => s.includes('Sarasota golden parcel: by-parcel lookup threw (timeout)'))).toBe(true);
    expect(mockTriggerNotification).not.toHaveBeenCalled();

    await runPropertyLookupCanary();
    expect(mockTriggerNotification).not.toHaveBeenCalled();

    const n3 = await runPropertyLookupCanary();
    expect(n3.ok).toBe(false);
    expect(n3.failures).toContain('Sarasota golden parcel: by-parcel lookup threw (timeout) — 3 nights running');
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
    expect(mockTriggerNotification).toHaveBeenCalledWith('property_lookup_canary_failed', {
      failures: ['Sarasota golden parcel: by-parcel lookup threw (timeout) — 3 nights running'],
    });
  });

  it('a clean night resets the streak so a later blip restarts at night 1', async () => {
    mockLookupByParcel.mockImplementation(async (parcel) => {
      if (parcel.county === 'Sarasota') throw abortError();
      return healthyRecord();
    });
    await runPropertyLookupCanary(); // night 1 transient
    await runPropertyLookupCanary(); // night 2 transient
    expect(mockTriggerNotification).not.toHaveBeenCalled();

    mockLookupByParcel.mockResolvedValue(healthyRecord()); // clean night resets
    const clean = await runPropertyLookupCanary();
    expect(clean.ok).toBe(true);

    mockLookupByParcel.mockImplementation(async (parcel) => {
      if (parcel.county === 'Sarasota') throw abortError();
      return healthyRecord();
    });
    const after = await runPropertyLookupCanary(); // back to night 1, not 3
    expect(after.failures).toEqual([]);
    expect(after.suppressed.some((s) => s.includes('night 1/3'))).toBe(true);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  it('a degraded parse (record present, surface gone) is a regression — pages on the first night', async () => {
    mockLookupByParcel.mockImplementation(async (parcel) => (
      parcel.county === 'Sarasota' ? { ...healthyRecord(), hasPool: null, poolCageSqft: null } : healthyRecord()
    ));
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual([
      'Sarasota golden parcel: pool not found on extra-features roll',
      'Sarasota golden parcel: screen cage sqft not parsed',
    ]);
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
  });

  it('a "returned no record" null is transient — suppressed on the first night', async () => {
    mockLookupByParcel.mockImplementation(async (parcel) => (
      parcel.county === 'Sarasota' ? null : healthyRecord()
    ));
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.suppressed.some((s) => s.includes('Sarasota golden parcel: by-parcel lookup returned no record'))).toBe(true);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  it('a wrong PAO parcel id from FDOR is a regression — pages immediately (normalization drift)', async () => {
    mockLookupParcelByPoint.mockResolvedValue({ county: 'Manatee', paoParcelId: '0579642409' });
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['FDOR cadastral layer: golden point resolves to the wrong PAO parcel id']);
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
  });

  it('a wrong-county FDOR hit is a regression — pages immediately (adjacent-polygon break)', async () => {
    // Layer reachable but resolved the wrong polygon → not a transient blip.
    mockLookupParcelByPoint.mockResolvedValue({ county: 'Sarasota', paoParcelId: '579642409' });
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(['FDOR cadastral layer: golden point resolves to the wrong county']);
    expect(mockTriggerNotification).toHaveBeenCalledTimes(1);
  });

  it('an FDOR layer miss is transient — suppressed on the first night', async () => {
    mockLookupParcelByPoint.mockResolvedValue(null);
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.suppressed.some((s) => s.includes('FDOR cadastral layer: golden point no longer resolves to a parcel'))).toBe(true);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
  });

  it('lookup rejections degrade to suppressed transient failures instead of throwing', async () => {
    mockLookupParcelByPoint.mockRejectedValue(new Error('arcgis down'));
    mockLookupByParcel.mockRejectedValue(new Error('county down'));
    const result = await runPropertyLookupCanary();
    expect(result.ok).toBe(true); // night 1 — all suppressed, nothing pages
    expect(result.failures).toEqual([]);
    expect(result.suppressed.length).toBe(1 + GOLDEN_PARCELS.length);
    expect(mockTriggerNotification).not.toHaveBeenCalled();
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
    const text = result.suppressed.join(' ');
    expect(text).toContain('Sarasota golden parcel: by-parcel lookup threw (ETIMEDOUT)');
    expect(text).toContain('Charlotte golden parcel: by-parcel lookup returned no record');
  });

  it('an AbortController timeout reads as (timeout), not the raw DOMException code 20', async () => {
    // Reproduces the 2026-06-13 Sarasota alert: the county PAO fetch aborted
    // on the canary timeout and surfaced as "by-parcel lookup threw (20)".
    mockLookupByParcel.mockImplementation(async (parcel) => {
      if (parcel.county === 'Sarasota') throw abortError();
      return healthyRecord();
    });
    const result = await runPropertyLookupCanary();
    const text = [...result.failures, ...result.suppressed].join(' ');
    expect(text).toContain('Sarasota golden parcel: by-parcel lookup threw (timeout)');
    expect(text).not.toContain('(20)');
  });

  it('throw labels carry only the error code — never the URL/parcel from err.message', async () => {
    const err = new Error('request to https://sc-pa.com/parcel/0069140016 failed');
    err.code = 'ECONNRESET';
    mockLookupByParcel.mockImplementation(async (parcel) => {
      if (parcel.county === 'Sarasota') throw err;
      return healthyRecord();
    });
    const result = await runPropertyLookupCanary();
    const text = [...result.failures, ...result.suppressed].join(' ');
    expect(text).toContain('(ECONNRESET)');
    expect(text).not.toContain('0069140016');
    expect(text).not.toContain('sc-pa.com');
  });

  it('a codeless thrown error falls back to the network/timeout label', async () => {
    mockLookupParcelByPoint.mockRejectedValue(new TypeError('fetch failed'));
    const result = await runPropertyLookupCanary();
    const text = [...result.failures, ...result.suppressed].join(' ');
    expect(text).toContain('FDOR cadastral layer: golden point lookup threw (TypeError)');
  });

  it('passes rethrowErrors to both lookups — without it the providers swallow errors into nulls and the throw labels never fire', async () => {
    await runPropertyLookupCanary();
    expect(mockLookupParcelByPoint).toHaveBeenCalledWith(
      expect.anything(), expect.anything(),
      expect.objectContaining({ rethrowErrors: true }),
    );
    for (const call of mockLookupByParcel.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ rethrowErrors: true }));
    }
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
