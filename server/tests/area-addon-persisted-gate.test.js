// GATE_AREA_ADDONS is a kill switch for STORED estimates too (codex round 2 on #6135), mirroring
// GATE_BERMUDA_SUPPRESSION: an estimate saved gate-on must not be re-priced, sent, recorded against a
// deposit or booked once the gate is off. Route/service boundaries that have a Bermuda test are
// mirrored beside it (estimate-blocking-precedence-matrix, estimate-slots-public-gates,
// estimate-public-accept-atomicity, estimate-manual-acceptance, estimate-public-parked-data); the
// detector itself is covered in pricing-engine-area-addon.test.js. This file covers the rest.

let mockEstimateRow = null;
jest.mock('../models/db', () => {
  const mock = jest.fn(() => ({ where: () => ({ first: async () => mockEstimateRow }) }));
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.raw = jest.fn((sql) => ({ __raw: sql }));
  mock.transaction = jest.fn(async (fn) => fn(mock));
  return mock;
});
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { generateEstimate } = require('../services/pricing-engine');
const { mapV1ToLegacyShape } = require('../services/pricing-engine/v1-legacy-mapper');

const HOME = { homeSqFt: 2000, lotSqFt: 7500 };
let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_AREA_ADDONS;
  delete process.env.GATE_AREA_ADDONS;
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_AREA_ADDONS;
  else process.env.GATE_AREA_ADDONS = savedGate;
});

const storedWithAddOn = () => {
  const prior = process.env.GATE_AREA_ADDONS;
  process.env.GATE_AREA_ADDONS = 'true';
  try {
    const engineInputs = { ...HOME, services: { areaAddOns: [{ key: 'web_sweep' }] } };
    return { engineInputs, result: mapV1ToLegacyShape(generateEstimate(engineInputs)) };
  } finally {
    if (prior === undefined) delete process.env.GATE_AREA_ADDONS; else process.env.GATE_AREA_ADDONS = prior;
  }
};

describe('re-price of a stored add-on estimate', () => {
  const { resolveServerAuthoritativePricing } = require('../services/admin-estimate-persistence');

  test('gate off: the real recompute path rejects (AREA_ADDONS_GATED, failClosed), no CLIENT_FALLBACK', async () => {
    const { engineInputs } = storedWithAddOn();
    await expect(resolveServerAuthoritativePricing({
      estimateData: { engineInputs },
      clientPreview: { annualTotal: 0 },
      quoteRequired: false,
      now: () => new Date(),
    })).rejects.toMatchObject({ code: 'AREA_ADDONS_GATED', failClosed: true, statusCode: 400 });
  });

  test('gate on: the same stored inputs re-price', async () => {
    const { engineInputs } = storedWithAddOn();
    process.env.GATE_AREA_ADDONS = 'true';
    const { audit } = await resolveServerAuthoritativePricing({
      estimateData: { engineInputs },
      clientPreview: { annualTotal: 0 },
      quoteRequired: false,
      now: () => new Date(),
    });
    expect(audit.pricing_authority).not.toBe('CLIENT_FALLBACK');
  });
});

describe('send boundary', () => {
  const { assertEstimateSendable } = require('../routes/admin-estimates')._internals;

  test.each([
    ['engine inputs', (stored) => ({ engineInputs: stored.engineInputs })],
    ['mapped result rows', (stored) => ({ result: stored.result })],
  ])('a persisted add-on estimate (%s) is NOT sendable while the gate is off: 409 AREA_ADDONS_GATED', (_label, shape) => {
    const estimate = { archived_at: null, estimate_data: JSON.stringify(shape(storedWithAddOn())) };
    expect(() => assertEstimateSendable(estimate)).toThrow(expect.objectContaining({
      statusCode: 409, code: 'AREA_ADDONS_GATED', message: expect.stringMatching(/GATE_AREA_ADDONS/),
    }));
  });

  test('gate on: the add-on send gate does not fire (later checks throw instead)', () => {
    process.env.GATE_AREA_ADDONS = 'true';
    const estimate = { archived_at: null, estimate_data: JSON.stringify({ engineInputs: storedWithAddOn().engineInputs }) };
    let thrown;
    try { assertEstimateSendable(estimate); } catch (err) { thrown = err; }
    expect(thrown).toBeTruthy();
    expect(thrown.code).not.toBe('AREA_ADDONS_GATED');
  });
});

describe('deposit record boundary (a payment intent minted gate-on must not be recorded gate-off)', () => {
  const { _private } = require('../services/estimate-deposits');

  test('gate off: the deposit is unrecordable, so the stale-deposit rail refunds it', async () => {
    mockEstimateRow = { id: 'est-1', status: 'sent', estimate_data: storedWithAddOn() };
    await expect(_private.depositStillRecordable('est-1')).resolves.toEqual({ recordable: false, reason: 'area_addons_gated' });
  });
});

describe('booking from a linked estimate (admin schedule)', () => {
  const { persistedAddOnRefusal, AREA_ADDON_RECURRING_MARK_WON_MESSAGE } = require('../services/estimate-manual-acceptance');
  const schedule = () => require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');

  test('a gated add-on estimate is refused 409 AREA_ADDONS_GATED, with the booking wording, whatever its status', () => {
    delete process.env.GATE_AREA_ADDONS;
    const refusal = persistedAddOnRefusal({ estimate_data: storedWithAddOn() }, { action: 'booking from it', checkRecurring: false });
    expect(refusal).toEqual({ code: 'AREA_ADDONS_GATED', message: expect.stringMatching(/before booking from it\.$/) });
  });

  test('the bermuda guard shares the helper and keeps its code and wording', () => {
    const refusal = persistedAddOnRefusal({ estimate_data: { engineRequest: { options: { bermudaSuppression: true } } } }, { action: 'booking from it' });
    expect(refusal).toEqual({ code: 'BERMUDA_SUPPRESSION_GATED', message: expect.stringMatching(/bermudagrass-suppression add-on.*before booking from it\.$/) });
  });

  test('a recurring estimate carrying an add-on is refused with the one-time-only code; an accepted one (checkRecurring off) is not', () => {
    process.env.GATE_AREA_ADDONS = 'true';
    const recurring = { estimate_data: storedWithAddOn(), monthly_total: 59, annual_total: 708, onetime_total: 0 };
    expect(persistedAddOnRefusal(recurring, { action: 'booking from it' })).toEqual({ code: 'AREA_ADDONS_ONE_TIME_ACCEPT_ONLY', message: AREA_ADDON_RECURRING_MARK_WON_MESSAGE });
    expect(persistedAddOnRefusal(recurring, { action: 'booking from it', checkRecurring: false })).toBeNull();
    expect(persistedAddOnRefusal({ estimate_data: {} }, { action: 'booking from it' })).toBeNull();
  });

  test('the schedule preflight asks it before the appointment transaction and skips the recurring check for an accepted estimate', () => {
    const src = schedule();
    const call = src.indexOf("persistedAddOnRefusal(linkedEstimate, {");
    const firstTransaction = src.indexOf('db.transaction', call);
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(firstTransaction);
    expect(src.slice(call, call + 300)).toContain("checkRecurring: linkedEstimate.status !== 'accepted'");
    expect(src.slice(call, call + 500)).toMatch(/refuse\(409, \{ error: addOnRefusal\.message, code: addOnRefusal\.code \}\)/);
  });
});
