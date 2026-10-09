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
  test('the preflight refuses a gated add-on estimate with 409 AREA_ADDONS_GATED before the appointment transaction', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const bermuda = src.indexOf("code: 'BERMUDA_SUPPRESSION_GATED'");
    const area = src.indexOf('estimateAreaAddOnsGated(linkedEstimate.estimate_data)');
    expect(bermuda).toBeGreaterThan(0);
    expect(area).toBeGreaterThan(bermuda);
    // Same preflight block as the Bermuda guard: nothing but that block sits between them.
    expect(src.slice(bermuda, area)).not.toMatch(/db\.transaction|trx\(/);
    expect(src.slice(area, area + 400)).toMatch(/status\(409\)[\s\S]*AREA_ADDONS_GATED_CODE/);
  });

  test('the preflight refuses a recurring estimate carrying an add-on before the appointment transaction (Codex r6)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    const check = src.indexOf('recurringAcceptWouldDropAreaAddOns(linkedEstimate');
    const firstTransaction = src.indexOf('db.transaction', src.indexOf('estimateAreaAddOnsGated(linkedEstimate.estimate_data)'));
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(firstTransaction);
    expect(src.slice(check, check + 400)).toMatch(/status\(409\)[\s\S]*AREA_ADDON_RECURRING_MARK_WON_MESSAGE[\s\S]*AREA_ADDONS_ONE_TIME_ONLY_CODE/);
    // An already-accepted estimate converts nothing here, so it is not refused.
    expect(src.slice(check - 120, check)).toMatch(/linkedEstimate\.status !== 'accepted'/);
  });
});
