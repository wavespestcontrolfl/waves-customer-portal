// The closeout holds SUBMITTED products to their hard product-level count limits
// (annual_max_apps, min_interval_days) before anything is written, so a spot product the
// tech added by hand (Celsius, Certainty, Blindside, Arena) cannot go past its yearly count
// just because the plan never listed it. Mocked database; the real counts are in
// lawn-v13-count-caps.db.test.js.
process.env.JWT_SECRET = 'completion-service-test-secret';

jest.mock('../models/db', () => {
  const db = jest.fn();
  db.raw = jest.fn((sql) => sql);
  db.schema = { hasColumn: jest.fn(async () => false), hasTable: jest.fn(async () => false) };
  db.transaction = jest.fn(async (callback) => callback(db));
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/completion-attempts', () => ({
  COMPLETION_SMS_DEFINITE_REJECTION_PREFIX: jest.requireActual('../services/completion-attempts').COMPLETION_SMS_DEFINITE_REJECTION_PREFIX,
  STALE_SIDE_EFFECTS_MS: jest.requireActual('../services/completion-attempts').STALE_SIDE_EFFECTS_MS,
  claimCompletionAttempt: jest.fn(),
  hashCompletionRequest: jest.fn(() => 'synthetic-request-hash'),
  markCompletionAttemptFailed: jest.fn(async () => {}),
}));
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({})),
}));
jest.mock('../services/visit-groups', () => ({ lockStopForRow: jest.fn(async () => {}), stopBaseKey: jest.fn(() => 'fixture-stop') }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: jest.fn(async () => null) }));

const db = require('../models/db');
const attempts = require('../services/completion-attempts');
const limits = require('../services/application-limits');
const { completeScheduledService, submittedProductLimitBlockPayload, applicationLimitBlockStatus } = require('../services/complete-scheduled-service');
const { etDateString } = require('../utils/datetime-et');
const completionObservationCatalog = require('../../shared/service-completion-observations.json');

const SERVICE_ID = '00000000-0000-4000-8000-000000000201';
const TECH_ID = '00000000-0000-4000-8000-000000000202';
const PROPERTY_ID = '00000000-0000-4000-8000-000000000204';
const CELSIUS_ID = '00000000-0000-4000-8000-000000000301';
const DEFAULT_ID = '00000000-0000-4000-8000-000000000302';
const actor = { techRole: 'technician', technicianId: TECH_ID };
let service;
let checkLimits;

const celsiusBlock = { type: 'annual_max_apps', matchType: 'product', matchValue: null, message: 'Celsius WG: 2/2 applications this year — LIMIT REACHED.', current: 2, max: 2 };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_LAWN_V13 = 'true';
  service = {
    id: SERVICE_ID,
    customer_id: '00000000-0000-4000-8000-000000000203',
    property_id: PROPERTY_ID,
    technician_id: TECH_ID,
    service_type: 'Every 6 Weeks Lawn Care Service',
    scheduled_date: etDateString(),
    status: 'on_site',
  };
  const builder = {};
  for (const method of ['where', 'leftJoin', 'select', 'orderBy', 'whereNot', 'whereIn', 'whereRaw', 'forUpdate', 'whereNotNull', 'whereNull', 'limit']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.first = jest.fn(async () => service);
  builder.columnInfo = jest.fn(async () => ({}));
  // A plain await of a query reads as no rows.
  builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  db.mockReturnValue(builder);
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'proceed', attempt: { id: 'fixture-attempt' } });
  checkLimits = jest.spyOn(limits, 'checkLimits').mockImplementation(async (customerId, productId) => (
    productId === CELSIUS_ID ? { allowed: false, warnings: [], blocks: [celsiusBlock] } : { allowed: true, warnings: [], blocks: [] }
  ));
});
afterEach(() => { delete process.env.GATE_LAWN_V13; jest.restoreAllMocks(); });

const complete = (products) => completeScheduledService({ serviceId: SERVICE_ID, body: { products }, actor });
// A closeout that passes this check meets the next refusal down the line (mutually exclusive
// observations, a 422 raised before any write), which proves the request got past the limits check.
const conflicting = completionObservationCatalog.lawn.filter(([id]) => ['dry-root-zone', 'saturated-soil'].includes(id)).map(([, label]) => label);
const completePastLimits = (products) => completeScheduledService({ serviceId: SERVICE_ID, body: { products, structuredObservations: conflicting }, actor });
const passed = (result) => expect(result).toMatchObject({ status: 422, body: { code: 'conflicting_structured_observations' } });
const applied = (productId) => ({ productId, productName: 'fixture', amount: 1, unit: 'oz' });

describe('closeout: submitted products against hard count limits', () => {
  test('a submitted product already at its yearly count refuses the completion with a 422 naming it, before any record is written', async () => {
    const result = await complete([applied(CELSIUS_ID)]);
    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({ code: 'application_limit_reached', productId: CELSIUS_ID, limitType: 'annual_max_apps', current: 2, max: 2 });
    expect(result.body.error).toMatch(/Celsius WG: 2\/2 applications this year/);
    expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fixture-attempt' }),
      expect.objectContaining({ message: 'application_limit_reached' }),
      db,
    );
    // The check is scoped to the treated property and leaves the visit's own ledger rows out.
    expect(checkLimits).toHaveBeenCalledWith(service.customer_id, CELSIUS_ID, expect.any(Date), expect.anything(), { propertyId: PROPERTY_ID, excludeScheduledServiceId: SERVICE_ID });
  });

  test('a default product with no limit in the way is not refused by this check', async () => {
    passed(await completePastLimits([applied(DEFAULT_ID)]));
    expect(checkLimits).toHaveBeenCalledWith(service.customer_id, DEFAULT_ID, expect.any(Date), expect.anything(), expect.objectContaining({ propertyId: PROPERTY_ID }));
  });

  test('a warning, an active-ingredient cap or a rate limit is not this check\'s hard count block', async () => {
    checkLimits.mockResolvedValue({ allowed: false, warnings: [], blocks: [
      { type: 'annual_max_rate', matchType: 'active_ingredient', matchValue: 'prodiamine', message: 'cap' },
      { type: 'annual_max_rate', matchType: 'product', message: 'rate' },
    ] });
    passed(await completePastLimits([applied(CELSIUS_ID)]));
  });

  test('a hard minimum interval refuses too', async () => {
    checkLimits.mockResolvedValue({ allowed: false, warnings: [], blocks: [{ type: 'min_interval_days', matchType: 'product', message: 'Dimension: only 10 days since last app (min 60).', current: 10, max: 60 }] });
    const result = await complete([applied(DEFAULT_ID)]);
    expect(result).toMatchObject({ status: 422, body: { code: 'application_limit_reached', limitType: 'min_interval_days' } });
  });

  test('gate off, a non-lawn visit and a visit with no submitted product read no limits', async () => {
    delete process.env.GATE_LAWN_V13;
    expect(await submittedProductLimitBlockPayload({ svc: service, products: [applied(CELSIUS_ID)], database: db })).toBeNull();
    process.env.GATE_LAWN_V13 = 'true';
    service.service_type = 'Quarterly Pest Control';
    expect(await submittedProductLimitBlockPayload({ svc: service, products: [applied(CELSIUS_ID)], database: db })).toBeNull();
    service.service_type = 'Every 6 Weeks Lawn Care Service';
    expect(await submittedProductLimitBlockPayload({ svc: service, products: [], database: db })).toBeNull();
    expect(checkLimits).not.toHaveBeenCalled();
  });

  test('a failed limits read fails closed: a retryable 503, the attempt marked failed, nothing written', async () => {
    checkLimits.mockRejectedValue(new Error('read failed'));
    expect(await submittedProductLimitBlockPayload({ svc: service, products: [applied(CELSIUS_ID)], database: db }))
      .toMatchObject({ code: 'application_limit_check_unavailable', productId: CELSIUS_ID, error: 'Could not check product limits — try again.' });
    const result = await complete([applied(CELSIUS_ID)]);
    expect(result).toMatchObject({ status: 503, body: { code: 'application_limit_check_unavailable' } });
    expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'fixture-attempt' }),
      expect.objectContaining({ message: 'application_limit_check_unavailable' }),
      db,
    );
  });

  test('a reached limit stays a 422; only an unreadable limit is a 503', () => {
    expect(applicationLimitBlockStatus({ code: 'application_limit_reached' })).toBe(422);
    expect(applicationLimitBlockStatus({ code: 'application_limit_check_unavailable' })).toBe(503);
  });
});
