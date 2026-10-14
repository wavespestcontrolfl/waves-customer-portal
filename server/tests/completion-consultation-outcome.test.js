/**
 * The Waves Assessment sheet's `consultationOutcome` in the /complete body
 * (GATE_ASSESSMENT_FAST_COMPLETE): accepted only for an assessment visit while
 * the gate is live, recorded through recordOutcome on the completion's own
 * transaction, and wired into completeScheduledService after the visit lock and
 * its expectedVisit check. The rollback itself (a refused completion leaves no
 * consultation_outcomes row) is proved against Postgres in
 * complete-scheduled-service-assessment-outcome-postgres.test.js (CI only).
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockRecordOutcome = jest.fn();
jest.mock('../services/consultation-outcomes', () => ({ recordOutcome: (...args) => mockRecordOutcome(...args) }));

const {
  consultationOutcomeBlockPayload,
  recordConsultationOutcomeInCompletion,
  consultationOutcomeRefusalResponse,
} = require('../services/completion-consultation-outcome');

const ASSESSMENT = { serviceKey: 'lawn_inspection' };
const OUTCOME = { outcome: 'warm', interests: ['lawn'], quotedAmount: null, extra: 'ignored' };

describe('consultationOutcomeBlockPayload', () => {
  const saved = process.env.GATE_ASSESSMENT_FAST_COMPLETE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_ASSESSMENT_FAST_COMPLETE; else process.env.GATE_ASSESSMENT_FAST_COMPLETE = saved;
  });
  const block = (overrides = {}) => consultationOutcomeBlockPayload({
    consultationOutcome: OUTCOME, completionProfile: ASSESSMENT, visitOutcome: 'completed', ...overrides,
  });

  test('no field: nothing to block, gate or not', () => {
    delete process.env.GATE_ASSESSMENT_FAST_COMPLETE;
    expect(consultationOutcomeBlockPayload({ completionProfile: { serviceKey: 'pest_control_quarterly' }, visitOutcome: 'completed' })).toBeNull();
  });

  test('an assessment with the gate live and a completed outcome is allowed', () => {
    process.env.GATE_ASSESSMENT_FAST_COMPLETE = 'true';
    expect(block()).toBeNull();
  });

  test.each([
    ['the gate is off', () => { delete process.env.GATE_ASSESSMENT_FAST_COMPLETE; }, {}],
    ['the gate is not exactly true', () => { process.env.GATE_ASSESSMENT_FAST_COMPLETE = '1'; }, {}],
    ['the visit is not an assessment', () => { process.env.GATE_ASSESSMENT_FAST_COMPLETE = 'true'; }, { completionProfile: { serviceKey: 'pest_control_quarterly' } }],
    ['the visit has no profile', () => { process.env.GATE_ASSESSMENT_FAST_COMPLETE = 'true'; }, { completionProfile: null }],
    ['the completion is not a completed visit', () => { process.env.GATE_ASSESSMENT_FAST_COMPLETE = 'true'; }, { visitOutcome: 'incomplete' }],
  ])('refused with 422 when %s', (_label, setup, overrides) => {
    setup();
    expect(block(overrides)).toMatchObject({ status: 422, body: { code: 'consultation_outcome_not_allowed' } });
  });

  test('a non-object field is a 400', () => {
    process.env.GATE_ASSESSMENT_FAST_COMPLETE = 'true';
    expect(block({ consultationOutcome: 'warm' })).toMatchObject({ status: 400, body: { code: 'consultation_outcome_invalid' } });
    expect(block({ consultationOutcome: [] })).toMatchObject({ status: 400 });
  });
});

describe('recordConsultationOutcomeInCompletion', () => {
  beforeEach(() => mockRecordOutcome.mockReset());
  const trx = { fake: 'trx' };
  const actor = { techRole: 'technician', technicianId: 'tech-1', technician: { name: 'Pat' } };

  test('calls recordOutcome on the completion transaction with the outcome fields only', async () => {
    mockRecordOutcome.mockResolvedValue({ id: 'co-1' });
    await recordConsultationOutcomeInCompletion({ trx, serviceId: 'svc-1', consultationOutcome: OUTCOME, actor });
    expect(mockRecordOutcome).toHaveBeenCalledWith(
      {
        outcome: 'warm', interests: ['lawn'], quotedAmount: null, scheduledServiceId: 'svc-1',
        recordedBy: 'Pat', actingTechnicianId: 'tech-1', actingIsAdmin: false,
      },
      { trx, duringCompletion: true },
    );
  });

  test('the call-back date (followUpAt) the sheet sends reaches recordOutcome unchanged, and an invalid one is the rule\'s own 400', async () => {
    mockRecordOutcome.mockResolvedValue({ id: 'co-1' });
    await recordConsultationOutcomeInCompletion({
      trx, serviceId: 'svc-1', consultationOutcome: { outcome: 'cold', followUpAt: '2026-10-20T09:00' }, actor,
    });
    expect(mockRecordOutcome.mock.calls[0][0]).toMatchObject({ outcome: 'cold', followUpAt: '2026-10-20T09:00' });

    mockRecordOutcome.mockRejectedValue(Object.assign(new Error('followUpAt must be a valid date/time'), { isOperational: true, statusCode: 400, code: 'VALIDATION' }));
    await expect(recordConsultationOutcomeInCompletion({
      trx, serviceId: 'svc-1', consultationOutcome: { outcome: 'cold', followUpAt: 'nope' }, actor,
    })).rejects.toMatchObject({ code: 'consultation_outcome_refused', statusCode: 400, outcomeCode: 'VALIDATION' });
  });

  test('no field: recordOutcome is not called', async () => {
    await recordConsultationOutcomeInCompletion({ trx, serviceId: 'svc-1', consultationOutcome: null, actor });
    expect(mockRecordOutcome).not.toHaveBeenCalled();
  });

  test('a consultation that already converted keeps its read and the completion goes on', async () => {
    mockRecordOutcome.mockRejectedValue(Object.assign(new Error('won'), { isOperational: true, statusCode: 409, code: 'ALREADY_WON' }));
    await expect(recordConsultationOutcomeInCompletion({ trx, serviceId: 'svc-1', consultationOutcome: OUTCOME, actor })).resolves.toBeNull();
  });

  test('any other refusal aborts the completion and keeps the outcome rule\'s status and code', async () => {
    mockRecordOutcome.mockRejectedValue(Object.assign(new Error('Not started'), { isOperational: true, statusCode: 409, code: 'CONSULTATION_NOT_HELD' }));
    const err = await recordConsultationOutcomeInCompletion({ trx, serviceId: 'svc-1', consultationOutcome: OUTCOME, actor }).catch((e) => e);
    expect(consultationOutcomeRefusalResponse(err)).toEqual({ status: 409, body: { error: 'Not started', code: 'CONSULTATION_NOT_HELD' } });
  });

  test('an unexpected error is not mapped', async () => {
    const boom = new Error('db down');
    mockRecordOutcome.mockRejectedValue(boom);
    await expect(recordConsultationOutcomeInCompletion({ trx, serviceId: 'svc-1', consultationOutcome: OUTCOME, actor })).rejects.toBe(boom);
    expect(consultationOutcomeRefusalResponse(boom)).toBeNull();
  });
});

describe('wiring in completeScheduledService', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const at = (needle) => {
    const i = source.indexOf(needle);
    expect(i).toBeGreaterThan(-1);
    return i;
  };

  test('the outcome is recorded on the completion transaction after the visit lock, the expectedVisit check and the lawn visit-type check', () => {
    const lock = at("const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();");
    const identity = at("{ code: 'visit_identity_changed' }");
    const lawn = at('assertLawnFastVisitTypeUnderLock({ trx,');
    const record = at('recordConsultationOutcomeInCompletion({');
    expect(lock).toBeLessThan(identity);
    expect(identity).toBeLessThan(lawn);
    expect(lawn).toBeLessThan(record);
    expect(source.slice(record, record + 200)).toContain('trx,');
  });

  test('the field is refused before any write, and the refusal is mapped to its HTTP answer', () => {
    const block = at('consultationOutcomeBlockPayload({');
    const lock = at("const lockedSvcRow = await trx('scheduled_services')");
    expect(block).toBeLessThan(lock);
    at('consultationOutcomeRefusalResponse(err)');
  });

  test('the customer read before the visit lock keeps its FOR SHARE default and is strengthened to FOR NO KEY UPDATE when the completion carries the read', () => {
    const read = at("const snapshotCustomerRow = await trx('customers')");
    const lock = at("const lockedSvcRow = await trx('scheduled_services').where({ id: svc.id }).forUpdate().first();");
    expect(read).toBeLessThan(lock);
    const statement = source.slice(read, lock);
    expect(statement.indexOf('.forShare()')).toBeGreaterThan(-1);
    expect(statement.indexOf('.forShare()')).toBeLessThan(statement.indexOf('q.forNoKeyUpdate()'));
    expect(statement).toContain('.modify((q) => consultationOutcome != null && q.forNoKeyUpdate())');
  });

  test('the strengthened read compiles to FOR NO KEY UPDATE only when the read is present (the last lock call wins)', () => {
    const knex = require('knex')({ client: 'pg' });
    const sql = (carries) => knex('customers').where({ id: 1 }).forShare().modify((q) => carries && q.forNoKeyUpdate()).first('id').toSQL().sql;
    expect(sql(true)).toContain('for no key update');
    expect(sql(false)).toContain('for share');
  });
});
