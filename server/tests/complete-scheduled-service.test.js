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
const { completeScheduledService } = require('../services/complete-scheduled-service');
const { etDateString } = require('../utils/datetime-et');

const SERVICE_ID = '00000000-0000-4000-8000-000000000101';
const TECH_ID = '00000000-0000-4000-8000-000000000102';
const actor = { techRole: 'technician', technicianId: TECH_ID };
let service;
let builder;

beforeEach(() => {
  jest.clearAllMocks();
  service = {
    id: SERVICE_ID,
    customer_id: '00000000-0000-4000-8000-000000000103',
    technician_id: TECH_ID,
    service_type: 'Quarterly Pest Control',
    scheduled_date: etDateString(),
    status: 'on_site',
  };
  builder = {};
  for (const method of ['where', 'leftJoin', 'select', 'orderBy', 'whereNot', 'whereIn', 'whereRaw', 'forUpdate', 'whereNotNull', 'whereNull', 'limit']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.first = jest.fn(async () => service);
  builder.columnInfo = jest.fn(async () => ({}));
  db.mockReturnValue(builder);
});

const complete = (body = {}, overrides = {}) => completeScheduledService({
  serviceId: SERVICE_ID, body, actor, ...overrides,
});

test.each([
  [{ offerInspectionCredit: 'true' }, 'offerInspectionCredit must be a boolean'],
  [{ clientPestRating: 6 }, 'client_pest_rating_invalid'],
  [{ completionPhotos: {} }, 'completion_photos_invalid'],
])('invalid submission returns a result before any database read: %j', async (body, error) => {
  const result = await complete(body);
  expect(result.status).toBe(400);
  expect(result.body.code || result.body.error).toBe(error);
  expect(db).not.toHaveBeenCalled();
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

const INVALID_AREAS = [false, '', 0, -1, 2500.5, 10000001, {}, []];
const withLawnGates = async (run) => {
  process.env.GATE_LAWN_COMPLETION_DEFAULTS = 'true';
  process.env.GATE_LAWN_PROPERTY_HISTORY = 'true';
  try {
    await run();
  } finally {
    delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
    delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  }
};

test.each([
  'front', [{ productId: '00000000-0000-4000-8000-000000000201' }], [{ productName: 'Iron' }],
  [{ productId: '00000000-0000-4000-8000-000000000201', productName: 'Iron', extra: true }], [{ productId: true, productName: 'Iron' }],
  [{ productId: 'p1', productName: 'Iron' }], [{ productId: 42, productName: 'Iron' }],
  [{ productId: '00000000-0000-4000-8000-000000000201', productName: 'Iron' }, { productId: '00000000-0000-4000-8000-000000000201', productName: 'Iron', reason: 'again' }],
  // A case-variant pair is the same PostgreSQL uuid: canonicalized before uniqueness (codex #4113 P2).
  [{ productId: '0000ABCD-0000-4000-8000-000000000201', productName: 'Iron' }, { productId: '0000abcd-0000-4000-8000-000000000201', productName: 'Iron' }],
])('malformed skipped plan defaults %j are rejected before a completion claim or database read, whatever the UI gates', async skippedProducts => {
  delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  const result = await complete({ lawnProtocolCompletion: { treatedSqft: 2500, skippedProducts } });
  expect(result).toMatchObject({ status: 400, body: { code: 'lawn_skipped_products_invalid' } });
  expect(db).not.toHaveBeenCalled();
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

test('skipped-default names are measured after trimming: padding around 180 characters is accepted, a 181-character name is rejected', async () => {
  delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
  const productId = '00000000-0000-4000-8000-000000000201';
  const payload = { success: true, serviceRecordId: 'fixture-record' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'replay', payload });
  try {
    const padded = `${' '.repeat(40)}${'x'.repeat(180)}${' '.repeat(40)}`;
    await expect(complete({ lawnProtocolCompletion: { treatedSqft: 2500, skippedProducts: [{ productId, productName: padded }] } }))
      .resolves.toEqual({ status: 200, body: payload });
    const result = await complete({ lawnProtocolCompletion: { treatedSqft: 2500, skippedProducts: [{ productId, productName: 'x'.repeat(181) }] } });
    expect(result).toMatchObject({ status: 400, body: { code: 'lawn_skipped_products_invalid' } });
  } finally {
    delete process.env.GATE_LAWN_ACTUALS_LEDGER;
  }
});

const withLedgerGateAlone = async (run) => {
  delete process.env.GATE_LAWN_COMPLETION_DEFAULTS;
  delete process.env.GATE_LAWN_PROPERTY_HISTORY;
  process.env.GATE_LAWN_ACTUALS_LEDGER = 'true';
  try {
    await run();
  } finally {
    delete process.env.GATE_LAWN_ACTUALS_LEDGER;
  }
};

test.each([-1, 2500.5, 10000001, 'front'])('invalid lawn visit area %j fails a fresh completion attempt after the claim under the ledger gate alone (defaults gates off)', async treatedSqft => {
  const completionAttempt = { id: 'fixture-attempt' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'proceed', attempt: completionAttempt });
  await withLedgerGateAlone(async () => {
    const result = await complete({ lawnProtocolCompletion: { treatedSqft } });
    expect(result).toMatchObject({ status: 400, body: { code: 'lawn_completion_area_invalid' } });
  });
  expect(attempts.claimCompletionAttempt).toHaveBeenCalled();
  expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: 'lawn_completion_area_invalid' }), expect.anything());
});

test.each([2500.5, 'front'])('lawn visit area %j never blocks a committed completion from replaying under the ledger gate alone', async treatedSqft => {
  const payload = { success: true, serviceRecordId: 'fixture-record' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'replay', payload });
  await withLedgerGateAlone(async () => {
    await expect(complete({ lawnProtocolCompletion: { treatedSqft } })).resolves.toEqual({ status: 200, body: payload });
  });
  expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalled();
});

test.each([undefined, null, 2500, '2500', ...INVALID_AREAS])('lawn visit area %j never blocks a committed completion from replaying', async treatedSqft => {
  const payload = { success: true, serviceRecordId: 'fixture-record' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'replay', payload });
  await withLawnGates(async () => {
    await expect(complete({ lawnProtocolCompletion: { treatedSqft } })).resolves.toEqual({ status: 200, body: payload });
  });
  expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalled();
});

test.each(INVALID_AREAS)('invalid lawn visit area %j fails a fresh completion attempt after the claim', async treatedSqft => {
  const completionAttempt = { id: 'fixture-attempt' };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'proceed', attempt: completionAttempt });
  await withLawnGates(async () => {
    const result = await complete({ lawnProtocolCompletion: { treatedSqft } });
    expect(result).toMatchObject({ status: 400, body: { code: 'lawn_completion_area_invalid' } });
  });
  expect(attempts.claimCompletionAttempt).toHaveBeenCalled();
  expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ message: 'lawn_completion_area_invalid' }), expect.anything());
});

test('a missing service returns the existing 404 payload', async () => {
  service = null;
  await expect(complete()).resolves.toEqual({ status: 404, body: { error: 'Service not found' } });
  expect(builder.where).toHaveBeenCalledWith('scheduled_services.id', SERVICE_ID);
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

test('submitted actor fields cannot override the authenticated technician', async () => {
  service.technician_id = '00000000-0000-4000-8000-000000000104';
  const result = await complete({ techRole: 'admin', actor: { techRole: 'admin' } });
  expect(result.status).toBe(403);
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

test('unexpected read failure rejects and preserves completion failure handling', async () => {
  const error = new Error('synthetic database failure');
  builder.first.mockRejectedValueOnce(error);
  await expect(complete()).rejects.toBe(error);
  expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(null, error, db);
});

test('a stored completion replays without rewriting or starting a new completion', async () => {
  const payload = { success: true, serviceRecordId: 'record-test', invoice: { id: 'invoice-test' } };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'replay', payload });
  await expect(complete({ idempotencyKey: 'body-key' }, { idempotencyKey: 'header-key' }))
    .resolves.toEqual({ status: 200, body: payload });
  expect(attempts.claimCompletionAttempt).toHaveBeenCalledWith({
    serviceId: SERVICE_ID, idempotencyKey: 'header-key', requestHash: 'synthetic-request-hash',
  }, db);
  expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalled();
});

test('a claim conflict returns its original status and payload', async () => {
  const payload = { code: 'completion_in_progress', retryAfterMs: 5000 };
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'conflict', status: 409, payload });
  await expect(complete({ idempotencyKey: 'body-key' }))
    .resolves.toEqual({ status: 409, body: payload });
  expect(attempts.claimCompletionAttempt).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'body-key' }), db);
  expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalled();
});

test('a saved packet blocks the individual replay/resume claim', async () => {
  service.visit_id = '00000000-0000-4000-8000-000000000105';
  const result = await complete();
  expect(result).toMatchObject({ status: 409, body: { code: 'visit_grouped', visitId: service.visit_id } });
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});

test('packet fields in the submitted form cannot grant packet ownership', async () => {
  service.visit_id = '00000000-0000-4000-8000-000000000105';
  const result = await complete({ packetRecord: { itemId: SERVICE_ID }, visitPacketId: SERVICE_ID });
  expect(result.status).toBe(409);
  expect(attempts.claimCompletionAttempt).not.toHaveBeenCalled();
});
