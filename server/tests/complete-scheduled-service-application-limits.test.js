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
// What the two batched limit reads answer: the catalog rows that exist and the products that carry a
// hard product-level count limit. `queried` records every table the closeout's limit check touched.
let catalogRows;
let limitedIds;
let queried;

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
    // No hard count limit row on it: the checker is never asked about it.
    expect(checkLimits).not.toHaveBeenCalled();
    // A default product beside a capped one is still judged on its own: the capped one refuses.
    expect((await complete([applied(DEFAULT_ID), applied(CELSIUS_ID)])).body).toMatchObject({ code: 'application_limit_reached', productId: CELSIUS_ID });
  });

  test('a warning, an active-ingredient cap or a rate limit is not this check\'s hard count block', async () => {
    checkLimits.mockResolvedValue({ allowed: false, warnings: [], blocks: [
      { type: 'annual_max_rate', matchType: 'active_ingredient', matchValue: 'prodiamine', message: 'cap' },
      { type: 'annual_max_rate', matchType: 'product', message: 'rate' },
    ] });
    passed(await completePastLimits([applied(CELSIUS_ID)]));
  });

  test('a hard minimum interval refuses too', async () => {
    limitedIds.add(DEFAULT_ID);
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

  test('the submitted list is bounded: more than 100 distinct product ids is a 400 before any query; duplicates count once', async () => {
    const many = Array.from({ length: 101 }, (_, i) => applied(`00000000-0000-4000-8000-${String(i + 1000).padStart(12, '0')}`));
    const result = await complete(many);
    expect(result).toMatchObject({ status: 400, body: { code: 'too_many_submitted_products', max: 100 } });
    expect(checkLimits).not.toHaveBeenCalled();
    // The helper itself reads nothing before it refuses.
    queried.length = 0;
    expect(await submittedProductLimitBlockPayload({ svc: service, products: many, database: db })).toMatchObject({ code: 'too_many_submitted_products' });
    expect(queried).toEqual([]);
    // 100 distinct ids, each repeated: within the bound.
    const hundred = Array.from({ length: 100 }, (_, i) => applied(`00000000-0000-4000-8000-${String(i + 2000).padStart(12, '0')}`));
    expect(await submittedProductLimitBlockPayload({ svc: service, products: [...hundred, ...hundred], database: db })).toBeNull();
    expect(applicationLimitBlockStatus({ code: 'too_many_submitted_products' })).toBe(400);
  });

  test('two batched reads whatever the list: unknown, malformed and duplicate ids cost no per-id query', async () => {
    const unknown = Array.from({ length: 50 }, (_, i) => applied(`00000000-0000-4000-8000-${String(i + 3000).padStart(12, '0')}`));
    const out = await submittedProductLimitBlockPayload({
      svc: service,
      products: [...unknown, applied('not-a-uuid'), applied(CELSIUS_ID), applied(CELSIUS_ID), applied(DEFAULT_ID), { productId: null }, null],
      database: db,
    });
    expect(out).toMatchObject({ code: 'application_limit_reached', productId: CELSIUS_ID, productName: 'Celsius WG' });
    expect(queried).toEqual(['products_catalog', 'product_limits']);
    // Only the one product that carries a hard count limit reaches the checker, once.
    expect(checkLimits).toHaveBeenCalledTimes(1);
  });

  test('only unknown ids: the catalog is read once, nothing else is asked', async () => {
    expect(await submittedProductLimitBlockPayload({ svc: service, products: [applied('00000000-0000-4000-8000-000000009999')], database: db })).toBeNull();
    expect(queried).toEqual(['products_catalog']);
    expect(checkLimits).not.toHaveBeenCalled();
  });
});
