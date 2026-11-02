/**
 * Re-service answers on /complete (step S2a, GATE_RESERVICE_ASKS): the tech's answer to each thing the customer told us.
 * Checked on a fresh attempt only, after the attempt claim and like the tips check: a wrong answer is a 400
 * `reservice_answer_invalid`, the attempt is marked failed and nothing else is read or written. A replay or a resume keeps
 * its stored result. Gathered once before the completion transaction, and only on a fresh run. Mocked database: this suite proves the refusal, the gate and the visit
 * rules. The frozen `service_data.reserviceAsks` itself is proved against real Postgres in
 * complete-scheduled-service-reservice-answers-postgres.test.js (CI).
 */
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
jest.mock('../services/reservice-asks', () => ({
  ...jest.requireActual('../services/reservice-asks'),
  gatherReserviceAsks: jest.fn(async () => ({ ok: true, lane: 'pest', window: {}, items: [{ id: 'booking:1', text: 'Ants' }] })),
}));
const mockRaiseOfficeBell = jest.fn(async () => null);
jest.mock('../services/reservice-office-bell', () => ({ raiseReserviceOfficeBell: (...args) => mockRaiseOfficeBell(...args) }));
jest.mock('../services/visit-groups', () => ({ lockStopForRow: jest.fn(async () => {}), stopBaseKey: jest.fn(() => 'fixture-stop') }));
jest.mock('../services/feature-flags', () => ({ isUserFeatureEnabled: jest.fn(async () => false) }));
jest.mock('../services/pest-pressure/store', () => ({ loadActiveConfig: jest.fn(async () => null) }));

const db = require('../models/db');
const attempts = require('../services/completion-attempts');
const { resolveCompletionProfileForScheduledService } = require('../services/service-completion-profiles');
const { gatherReserviceAsks } = require('../services/reservice-asks');
const { completeScheduledService } = require('../services/complete-scheduled-service');
const { etDateString } = require('../utils/datetime-et');
const completionObservationCatalog = require('../../shared/service-completion-observations.json');

const SERVICE_ID = '00000000-0000-4000-8000-000000000601';
const TECH_ID = '00000000-0000-4000-8000-000000000602';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000603';
const actor = { techRole: 'technician', technicianId: TECH_ID };
const gateWas = process.env.GATE_RESERVICE_ASKS;
let service;
let builder;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_RESERVICE_ASKS = 'true';
  service = {
    id: SERVICE_ID, customer_id: CUSTOMER_ID, technician_id: TECH_ID,
    service_type: 'Pest Control Re-Service', is_callback: true, scheduled_date: etDateString(), status: 'on_site',
  };
  resolveCompletionProfileForScheduledService.mockResolvedValue({ serviceKey: 'pest_re_service' });
  builder = {};
  for (const method of ['where', 'leftJoin', 'select', 'orderBy', 'whereNot', 'whereIn', 'whereRaw', 'forUpdate', 'whereNotNull', 'whereNull', 'limit']) {
    builder[method] = jest.fn(() => builder);
  }
  builder.first = jest.fn(async () => service);
  builder.columnInfo = jest.fn(async () => ({}));
  builder.insert = jest.fn(() => builder);
  builder.update = jest.fn(async () => 1);
  builder.returning = jest.fn(async () => []);
  builder.then = (resolve, reject) => Promise.resolve([]).then(resolve, reject);
  db.mockImplementation(() => builder);
  attempts.claimCompletionAttempt.mockResolvedValue({ action: 'proceed', attempt: { id: 'fixture-attempt' } });
});
afterAll(() => {
  if (gateWas === undefined) delete process.env.GATE_RESERVICE_ASKS; else process.env.GATE_RESERVICE_ASKS = gateWas;
});

// A run that gets past the answers check meets the next refusal down the line (the lawn observations posted here are
// not a pest visit's, a 422 raised before any write), which proves the request went on.
const conflicting = completionObservationCatalog.lawn.filter(([id]) => ['dry-root-zone', 'saturated-soil'].includes(id)).map(([, label]) => label);
const complete = (body = {}, who = actor) => completeScheduledService({
  serviceId: SERVICE_ID, actor: who, body: { visitOutcome: 'completed', structuredObservations: conflicting, ...body },
});
const BAD = { items: [{ itemId: 'booking:1', answer: 'treated', productIds: ['not-on-this-visit'] }] };
const GOOD = { items: [{ itemId: 'booking:1', answer: 'noted' }] };
const refused = { status: 400, body: { error: expect.any(String), code: 'reservice_answer_invalid' } };

describe('the reserviceAnswers field on /complete', () => {
  test('gate on, a re-service, a wrong answer: 400 in plain words, the attempt marked failed, nothing gathered or written', async () => {
    const result = await complete({ reserviceAnswers: BAD });

    expect(result).toEqual(refused);
    expect(result.body.error).toMatch(/not one of the products on this visit/);
    expect(attempts.claimCompletionAttempt).toHaveBeenCalledTimes(1);
    expect(attempts.markCompletionAttemptFailed).toHaveBeenCalledWith(
      { id: 'fixture-attempt' }, expect.objectContaining({ message: 'reservice_answer_invalid' }), expect.anything(),
    );
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
    // Only the claim's lock and the visit re-check ran (both read-only here: the claim itself is mocked).
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(builder.insert).not.toHaveBeenCalled();
    expect(builder.update).not.toHaveBeenCalled();
  });

  test('a treated answer may name a product that is on the completion', async () => {
    const result = await complete({
      products: [{ productId: 'prod-on-visit', amount: 1, unit: 'oz' }],
      reserviceAnswers: { items: [{ itemId: 'booking:1', answer: 'treated', productIds: ['prod-on-visit'] }] },
    });

    expect(result.body?.code).not.toBe('reservice_answer_invalid');
  });

  test('a callback whose catalog row is not a re-service key is still a re-service', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue({ serviceKey: 'quarterly_pest_control' });

    expect(await complete({ reserviceAnswers: BAD })).toEqual(refused);
  });

  test('the catalog re-service key counts when the row is not flagged a callback', async () => {
    service.is_callback = false;

    expect(await complete({ reserviceAnswers: BAD })).toEqual(refused);
  });

  test('gate off: the field is ignored whatever it holds', async () => {
    delete process.env.GATE_RESERVICE_ASKS;

    const result = await complete({ reserviceAnswers: BAD });

    expect(result).toMatchObject({ status: 422 });
    expect(result.body.code).not.toBe('reservice_answer_invalid');
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
    expect(mockRaiseOfficeBell).not.toHaveBeenCalled();
  });

  test('gate set to anything but true is off', async () => {
    process.env.GATE_RESERVICE_ASKS = '1';

    expect(await complete({ reserviceAnswers: BAD })).toMatchObject({ status: 422 });
  });

  test('a visit that is not a re-service ignores the field', async () => {
    service.is_callback = false;
    service.service_type = 'Quarterly Pest Control Service';
    resolveCompletionProfileForScheduledService.mockResolvedValue({ serviceKey: 'quarterly_pest_control' });

    const result = await complete({ reserviceAnswers: BAD });

    expect(result).toMatchObject({ status: 422 });
    expect(result.body.code).not.toBe('reservice_answer_invalid');
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
  });

  test('the rodent trapping follow-up is a callback but never a re-service here', async () => {
    resolveCompletionProfileForScheduledService.mockResolvedValue({ serviceKey: 'rodent_trapping_followup' });

    const result = await complete({ reserviceAnswers: BAD });

    expect(result).toMatchObject({ status: 422 });
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
  });

  test.each(['inspection_only', 'customer_declined', 'follow_up_needed', 'customer_concern'])(
    'a %s outcome ignores the field and gathers nothing (only a performed completion may say "treated")',
    async (visitOutcome) => {
      const result = await complete({ visitOutcome, reserviceAnswers: BAD });

      expect(result.body?.code).not.toBe('reservice_answer_invalid');
      expect(gatherReserviceAsks).not.toHaveBeenCalled();
      expect(mockRaiseOfficeBell).not.toHaveBeenCalled();
    },
  );

  test('an incomplete visit ignores the field', async () => {
    const result = await complete({ visitOutcome: 'incomplete', reserviceAnswers: BAD });

    expect(result.body?.code).not.toBe('reservice_answer_invalid');
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
  });

  test('a backdated backlog closeout ignores the field and never gathers', async () => {
    service.scheduled_date = '2026-01-05';

    const result = await complete({ backfill: true, reserviceAnswers: BAD }, { techRole: 'admin', technicianId: TECH_ID });

    expect(result.body?.code).not.toBe('reservice_answer_invalid');
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
    expect(mockRaiseOfficeBell).not.toHaveBeenCalled();
  });

  test('a missing field passes (the record still keeps what the customer said): the asks are gathered once, after the claim', async () => {
    attempts.claimCompletionAttempt.mockImplementation(async () => {
      expect(gatherReserviceAsks).not.toHaveBeenCalled();
      return { action: 'proceed', attempt: { id: 'fixture-attempt' } };
    });

    await complete({}).catch(() => {});

    expect(attempts.claimCompletionAttempt).toHaveBeenCalledTimes(1);
    expect(gatherReserviceAsks).toHaveBeenCalledTimes(1);
    expect(gatherReserviceAsks).toHaveBeenCalledWith(SERVICE_ID, { now: expect.any(Date) });
  });

  test('valid answers pass the check and reach the gather', async () => {
    await complete({ reserviceAnswers: GOOD }).catch(() => {});

    expect(attempts.claimCompletionAttempt).toHaveBeenCalledTimes(1);
    expect(gatherReserviceAsks).toHaveBeenCalledTimes(1);
  });

  test('a replay returns its stored result and gathers nothing', async () => {
    attempts.claimCompletionAttempt.mockResolvedValue({ action: 'replay', payload: { success: true, serviceRecordId: 'rec-1' } });

    const result = await complete({ reserviceAnswers: GOOD });

    expect(result).toEqual({ status: 200, body: { success: true, serviceRecordId: 'rec-1' } });
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
    expect(mockRaiseOfficeBell).not.toHaveBeenCalled();
  });

  test('a resume of a committed completion is never refused by the answers check and gathers nothing', async () => {
    attempts.claimCompletionAttempt.mockResolvedValue({ action: 'resume', attempt: { id: 'fixture-attempt' }, releasedForResume: false });

    let result;
    try { result = await complete({ reserviceAnswers: BAD }); } catch (err) { result = { thrown: err.message }; }

    expect(result?.body?.code).not.toBe('reservice_answer_invalid');
    expect(attempts.markCompletionAttemptFailed).not.toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ message: 'reservice_answer_invalid' }), expect.anything(),
    );
    expect(gatherReserviceAsks).not.toHaveBeenCalled();
    expect(mockRaiseOfficeBell).not.toHaveBeenCalled();
  });

  test('a gather that fails is logged and never refuses the completion', async () => {
    gatherReserviceAsks.mockRejectedValueOnce(new Error('synthetic read failure'));
    const logger = require('../services/logger');

    const result = await complete({ reserviceAnswers: GOOD }).catch((err) => err);

    expect(result?.body?.code).not.toBe('reservice_answer_invalid');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('re-service asks gather failed'));
    expect(mockRaiseOfficeBell).not.toHaveBeenCalled();
  });
});

// This suite's fake database stops at an early refusal, before the completion transaction, so the bell's wiring is
// pinned in the source here; the real completion runs it in complete-scheduled-service-reservice-answers-postgres.test.js.
describe('the re-service office bell wiring (GATE_RESERVICE_ASKS, step S3b)', () => {
  const source = require('fs').readFileSync(require.resolve('../services/complete-scheduled-service'), 'utf8');
  const setAt = source.indexOf('reserviceAsksFrozen = asksFreeze.freeze;');
  const commitAt = source.indexOf('// The durable completion artifacts are committed.');
  const callAt = source.indexOf("require('./reservice-office-bell').raiseReserviceOfficeBell({");
  const blockAt = source.lastIndexOf('if (reserviceAsksFrozen', callAt);
  const block = source.slice(blockAt, source.indexOf('\n    }\n', callAt));

  test('the frozen block is kept where the freeze is written, inside the completion transaction', () => {
    expect(setAt).toBeGreaterThan(-1);
    expect(source.indexOf('serviceData.reserviceAsks = asksFreeze.freeze;')).toBeLessThan(setAt);
    expect(source.indexOf('let reserviceAsksFrozen = null;')).toBeLessThan(source.indexOf('const asksFreeze'));
    expect(source.match(/reserviceAsksFrozen = /g)).toHaveLength(2); // the declaration and the one assignment
  });

  test('the bell follows the commit, runs on a fresh run only, and is fire and forget with a catch', () => {
    expect(callAt).toBeGreaterThan(commitAt);
    expect(commitAt).toBeGreaterThan(setAt);
    expect(block).toContain('reserviceAsksFrozen && !resumingCommittedCompletion');
    expect(block).toContain('freeze: reserviceAsksFrozen');
    expect(block).toContain('.catch(');
    expect(block).not.toMatch(/await /);
    expect(source.match(/raiseReserviceOfficeBell\(/g)).toHaveLength(1);
  });

  test('nothing that can return early sits between the commit and the bell', () => {
    expect(source.slice(commitAt, callAt)).not.toMatch(/\breturn\b\s*\(?\{/);
  });
});
