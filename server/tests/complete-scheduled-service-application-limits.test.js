// The closeout never refuses for a hard product count limit (annual_max_apps, min_interval_days):
// it records what was applied and FLAGS an over-limit application (or an unreadable limit) for the
// office. Mocked database; the real counts are in lawn-v13-count-caps.db.test.js and the real
// closeout in complete-scheduled-service-application-limits-postgres.test.js.
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
const { completeScheduledService, submittedProductLimitFindings, recordedProductLimitFindings, rawProductsTooManyPayload, notifyOfficeOfLimitFindings } = require('../services/complete-scheduled-service');
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
// What the two batched limit reads answer: the catalog rows that exist and the products that carry a
// hard product-level count limit. `queried` records every table the closeout's limit check touched.
let catalogRows;
let limitedIds;
let queried;

const celsiusViolation = { type: 'annual_max_apps', message: 'Celsius WG: 2/2 other applications in the year — LIMIT REACHED.', current: 2, max: 2 };

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
  // The batched reads: products_catalog by id, product_limits by product_id.
  const batched = (table, answer) => {
    const q = { ids: null };
    for (const method of ['where', 'select', 'leftJoin', 'orderBy', 'whereNot', 'whereRaw', 'whereNotNull', 'whereNull', 'limit', 'forUpdate']) q[method] = jest.fn(() => q);
    q.whereIn = jest.fn((column, ids) => { if (Array.isArray(ids) && !q.ids) q.ids = ids; return q; });
    q.first = jest.fn(async () => service);
    q.columnInfo = jest.fn(async () => ({}));
    q.then = (resolve, reject) => Promise.resolve(q.ids ? answer(q.ids) : []).then(resolve, reject);
    queried.push(table);
    return q;
  };
  catalogRows = [{ id: CELSIUS_ID, name: 'Celsius WG' }, { id: DEFAULT_ID, name: 'Default fixture' }];
  limitedIds = new Set([CELSIUS_ID]);
  queried = [];
  db.mockImplementation((table) => {
    if (table === 'products_catalog') return batched(table, (ids) => catalogRows.filter((row) => ids.includes(row.id)));
    if (table === 'product_limits') return batched(table, (ids) => ids.filter((id) => limitedIds.has(id)).map((id) => ({ product_id: id })));
    return builder;
  });
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'proceed', attempt: { id: 'fixture-attempt' } });
  // The closeout audit returns the violated hard limits (an array; empty = within every limit).
  checkLimits = jest.spyOn(limits, 'auditHardCountLimits').mockImplementation(async (customerId, productId) => (
    productId === CELSIUS_ID ? [celsiusViolation] : []
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

describe('closeout: hard count limits flag, they never refuse', () => {
  const findings = (productIds, extra = {}) => submittedProductLimitFindings({ svc: service, productIds, database: db, ...extra });

  test('a submitted product already at its yearly count does NOT refuse the closeout: it passes this point and meets the next ordinary check', async () => {
    passed(await completePastLimits([applied(CELSIUS_ID)]));
    expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: 'application_limit_reached' }), expect.anything());
    // The limits are not even read before the products are recorded.
    expect(checkLimits).not.toHaveBeenCalled();
  });

  test('over the yearly count: one finding that names the product and carries no removal instruction', async () => {
    const out = await findings([CELSIUS_ID]);
    expect(out).toEqual([{
      code: 'application_limit_exceeded', productId: CELSIUS_ID, productName: 'Celsius WG', limitType: 'annual_max_apps', current: 2, max: 2,
      message: 'Recorded. The office will review: Celsius WG is over its yearly application limit.',
    }]);
    expect(out[0].message).not.toMatch(/remove|delete/i);
    // Scoped to the treated property, leaving the visit's own ledger rows out.
    expect(checkLimits).toHaveBeenCalledWith(service.customer_id, CELSIUS_ID, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), expect.anything(), { propertyId: PROPERTY_ID, excludeScheduledServiceId: SERVICE_ID });
  });

  test('a hard minimum interval is a finding too, worded for the interval', async () => {
    limitedIds.add(DEFAULT_ID);
    checkLimits.mockResolvedValue([{ type: 'min_interval_days', message: 'only 10 days from another application (min 60).', current: 10, max: 60 }]);
    const out = await findings([DEFAULT_ID]);
    expect(out).toEqual([expect.objectContaining({ code: 'application_limit_exceeded', limitType: 'min_interval_days', current: 10, max: 60, message: 'Recorded. The office will review: Default fixture is over its minimum days between applications.' })]);
  });

  test('a default product with no hard count limit is never asked of the audit', async () => {
    expect(await findings([DEFAULT_ID])).toEqual([]);
    expect(checkLimits).not.toHaveBeenCalled();
    // Only product-level hard count limits are audited (the audit method returns nothing else).
    checkLimits.mockResolvedValue([]);
    expect(await findings([CELSIUS_ID])).toEqual([]);
  });

  test('EVERY violated hard limit of a product is its own finding (yearly count and minimum interval), each worded for its limit', async () => {
    checkLimits.mockResolvedValue([
      celsiusViolation,
      { type: 'min_interval_days', message: 'only 19 days from another application (min 60).', current: 19, max: 60 },
    ]);
    const out = await findings([CELSIUS_ID]);
    expect(out.map((f) => [f.code, f.limitType, f.current, f.max])).toEqual([
      ['application_limit_exceeded', 'annual_max_apps', 2, 2],
      ['application_limit_exceeded', 'min_interval_days', 19, 60],
    ]);
    expect(out.map((f) => f.message)).toEqual([
      'Recorded. The office will review: Celsius WG is over its yearly application limit.',
      'Recorded. The office will review: Celsius WG is over its minimum days between applications.',
    ]);
  });

  test('gate off, a non-lawn visit and an empty list read nothing', async () => {
    delete process.env.GATE_LAWN_V13;
    expect(await findings([CELSIUS_ID])).toEqual([]);
    process.env.GATE_LAWN_V13 = 'true';
    service.service_type = 'Quarterly Pest Control';
    expect(await findings([CELSIUS_ID])).toEqual([]);
    service.service_type = 'Every 6 Weeks Lawn Care Service';
    expect(await findings([])).toEqual([]);
    expect(queried).toEqual([]);
    expect(checkLimits).not.toHaveBeenCalled();
  });

  test('a limits read that fails is a finding, never a refusal: application_limit_check_unavailable', async () => {
    checkLimits.mockRejectedValue(new Error('read failed'));
    expect(await findings([CELSIUS_ID])).toEqual([expect.objectContaining({
      code: 'application_limit_check_unavailable', productId: CELSIUS_ID,
      message: 'Recorded. The office will review: product limits could not be checked for this visit.',
    })]);
    // The closeout itself still passes this point.
    passed(await completePastLimits([applied(CELSIUS_ID)]));
  });

  test('a failed batch read is one unavailable finding', async () => {
    db.mockImplementation(() => { throw new Error('synthetic outage'); });
    expect(await findings([CELSIUS_ID])).toEqual([expect.objectContaining({ code: 'application_limit_check_unavailable' })]);
  });

  test('two batched reads whatever the list: unknown, malformed and duplicate ids cost no per-id query', async () => {
    const unknown = Array.from({ length: 50 }, (_, i) => `00000000-0000-4000-8000-${String(i + 3000).padStart(12, '0')}`);
    const out = await findings([...unknown, 'not-a-uuid', CELSIUS_ID, CELSIUS_ID, DEFAULT_ID, null]);
    expect(out).toHaveLength(1);
    expect(queried).toEqual(['products_catalog', 'product_limits']);
    expect(checkLimits).toHaveBeenCalledTimes(1);
    queried.length = 0;
    expect(await findings(['00000000-0000-4000-8000-000000009999'])).toEqual([]);
    expect(queried).toEqual(['products_catalog']);
  });
});

describe('the findings path never goes quiet', () => {
  const record = { id: 'record-1', service_date: etDateString() };
  const unavailable = [expect.objectContaining({ code: 'application_limit_check_unavailable', message: 'Recorded. The office will review: product limits could not be checked for this visit.' })];

  test('a failed ledger lookup is the unavailable finding (eligible lawn visit, gate on), not a silent log', async () => {
    const failing = jest.fn(() => { throw new Error('ledger lookup failed'); });
    expect(await recordedProductLimitFindings({ svc: service, record, database: failing })).toEqual(unavailable);
    expect(failing).toHaveBeenCalledWith('property_application_history');
  });

  test('a ledger lookup that returns nothing means nothing was recorded: no finding', async () => {
    const empty = () => ({ where: () => ({ whereNull: () => ({ whereNotNull: () => ({ distinct: async () => [] }) }) }) });
    expect(await recordedProductLimitFindings({ svc: service, record, database: empty })).toEqual([]);
  });

  test('ineligible visits stay quiet: gate off, a non-lawn visit', async () => {
    const failing = jest.fn(() => { throw new Error('ledger lookup failed'); });
    delete process.env.GATE_LAWN_V13;
    expect(await recordedProductLimitFindings({ svc: service, record, database: failing })).toEqual([]);
    process.env.GATE_LAWN_V13 = 'true';
    service.service_type = 'Quarterly Pest Control';
    expect(await recordedProductLimitFindings({ svc: service, record, database: failing })).toEqual([]);
    expect(failing).not.toHaveBeenCalled();
  });

  test('a bell that is not recorded (notifyAdmin returns null) is logged, never thrown', async () => {
    const notify = jest.spyOn(require('../services/notification-service'), 'notifyAdmin').mockResolvedValue(null);
    const logger = require('../services/logger');
    await expect(notifyOfficeOfLimitFindings({ svc: service, record, findings: [{ code: 'application_limit_check_unavailable', productId: null }] })).resolves.toBeUndefined();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/bell NOT recorded for record record-1/));
  });
});

describe('the raw products array is capped at the closeout entry', () => {
  test('more than 200 entries is a 400 before the claim, a lookup or any write; 200 is fine', async () => {
    const many = Array.from({ length: 201 }, () => applied(DEFAULT_ID));
    expect(await complete(many)).toMatchObject({ status: 400, body: { code: 'too_many_submitted_products', max: 200 } });
    expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
    expect(queried).toEqual([]);
    expect(rawProductsTooManyPayload(many.slice(0, 200))).toBeNull();
    expect(rawProductsTooManyPayload(undefined)).toBeNull();
    expect(rawProductsTooManyPayload(many)).toMatchObject({ code: 'too_many_submitted_products' });
  });
});

describe('the office notification for a finding', () => {
  const record = { id: 'record-1' };
  test('one admin notification per finding, deduped per record + code + product, naming the limit; a failure never throws', async () => {
    const notify = jest.spyOn(require('../services/notification-service'), 'notifyAdmin').mockResolvedValue({ id: 'n1' });
    const over = { code: 'application_limit_exceeded', productId: CELSIUS_ID, productName: 'Celsius WG', limitType: 'annual_max_apps', current: 2, max: 2 };
    await notifyOfficeOfLimitFindings({ svc: service, record, findings: [over, { code: 'application_limit_check_unavailable', productId: null }] });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[0][0]).toBe('service');
    expect(notify.mock.calls[0][2]).toMatch(/Celsius WG .* over its yearly application limit \(2 of 2 already used\)/);
    expect(notify.mock.calls[0][3]).toMatchObject({ bell: true, dedupeKey: `application-limit-finding:record-1:application_limit_exceeded:${CELSIUS_ID}:annual_max_apps`, link: `/admin/customers?customerId=${service.customer_id}` });
    expect(notify.mock.calls[1][3].dedupeKey).toBe('application-limit-finding:record-1:application_limit_check_unavailable:all:all');
    // A product over both limits rings once per limit type.
    notify.mockClear();
    await notifyOfficeOfLimitFindings({ svc: service, record, findings: [over, { ...over, limitType: 'min_interval_days', current: 19, max: 60 }] });
    expect(notify.mock.calls.map((call) => call[3].dedupeKey)).toEqual([
      `application-limit-finding:record-1:application_limit_exceeded:${CELSIUS_ID}:annual_max_apps`,
      `application-limit-finding:record-1:application_limit_exceeded:${CELSIUS_ID}:min_interval_days`,
    ]);
    expect(notify.mock.calls[1][2]).toMatch(/minimum days between applications \(only 19 days from another application, minimum 60\)/);
    notify.mockRejectedValue(new Error('bell down'));
    await expect(notifyOfficeOfLimitFindings({ svc: service, record, findings: [over] })).resolves.toBeUndefined();
  });
});
