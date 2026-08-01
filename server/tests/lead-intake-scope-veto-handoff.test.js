/**
 * lead-intake ⇄ estimator scope-guard handoff contract.
 *
 * The intake state machine hands an SMS reply to the estimator engine and
 * falls back to the legacy shell path (draft estimate + owner alert) when
 * the handoff does not start. That fallback is correct for OPERATIONAL
 * failures — gate off, cooldown, a failed durable bell — because a lead
 * must never be lost. It is WRONG for a scope veto: "power wash my yard"
 * on an awaiting_service lead would still produce an estimate and alert
 * the owner for work Waves does not do.
 *
 * startSmsThreadDraft marks those refusals result.terminal, and
 * engineDraftHandoff turns them into { drafted: false, terminal: true } so
 * handleIntakeReply exits without drafting or notifying — and without
 * stamping 'estimate_drafted', which would be a lie.
 */

let mockCustomerUpdates;
let mockEstimateInserts;
let mockSmsSends;

jest.mock('../models/db', () => {
  const db = (table) => {
    const chain = {
      select() { return chain; },
      join() { return chain; },
      andWhere() { return chain; },
      orWhere() { return chain; },
      where() { return chain; },
      whereIn() { return chain; },
      whereNull() { return chain; },
      whereNot() { return chain; },
      whereRaw() { return chain; },
      orderBy() { return chain; },
      limit() { return chain; },
      returning() { return chain; },
      async first() { return null; },
      async update(patch) {
        if (table === 'customers') mockCustomerUpdates.push(patch);
        return 1;
      },
      insert(row) {
        if (table === 'estimates') mockEstimateInserts.push(row);
        const rows = [{ id: 'est-new', ...row }];
        const inserted = Promise.resolve(rows);
        inserted.returning = async () => rows;
        return inserted;
      },
      then(resolve, reject) { return Promise.resolve([]).then(resolve, reject); },
    };
    return chain;
  };
  db.raw = () => ({});
  db.fn = { now: () => new Date() };
  // The shell path takes a phone-scoped advisory lock around the draft.
  db.transaction = async (cb) => {
    const trx = (table) => db(table);
    trx.raw = () => ({});
    return cb(trx);
  };
  return db;
});

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('../services/twilio', () => ({
  sendSMS: (...args) => { mockSmsSends.push(args); return Promise.resolve({ sid: 'SM1' }); },
}));

const mockClassify = jest.fn();
jest.mock('../services/sms-service-intent', () => ({
  classifyServiceIntent: (...args) => mockClassify(...args),
}));

jest.mock('../services/estimate-clarify-asks', () => ({
  recordClarifyAnswer: jest.fn().mockResolvedValue(true),
  parkClarifyAsk: jest.fn().mockResolvedValue(true),
  clarifyAsksEnabled: () => false,
}));

const mockStartSmsThreadDraft = jest.fn();
jest.mock('../services/estimator-engine/sms-thread', () => ({
  smsThreadDraftsEnabled: () => true,
  startSmsThreadDraft: (...args) => mockStartSmsThreadDraft(...args),
}));

const { handleIntakeReply } = require('../services/lead-intake');

const CUSTOMER = () => ({
  id: 'cust-1',
  phone: '+19415550123',
  address_line1: '100 Sample St',
  lead_intake_status: 'awaiting_service',
});

beforeEach(() => {
  jest.clearAllMocks();
  mockCustomerUpdates = [];
  mockEstimateInserts = [];
  mockSmsSends = [];
  mockClassify.mockResolvedValue({ interest: 'pest', method: 'regex' });
});

describe('terminal scope veto', () => {
  for (const skipped of ['out_of_scope_service', 'out_of_scope_service_thread', 'no_quote_intent_ai_out_of_scope', 'no_quote_intent_ai_existing_job']) {
    test(`${skipped} ⇒ handled, no estimate, no owner alert, status unchanged`, async () => {
      mockStartSmsThreadDraft.mockResolvedValue({ started: false, skipped, terminal: true });

      const result = await handleIntakeReply(CUSTOMER(), 'power wash my yard');

      expect(result.handled).toBe(true);
      // The legacy fallback must not have run.
      expect(mockEstimateInserts).toHaveLength(0);
      expect(mockSmsSends).toHaveLength(0);
      // …and the lead is NOT falsely stamped as drafted.
      expect(mockCustomerUpdates.some((p) => p.lead_intake_status === 'estimate_drafted')).toBe(false);
    });
  }
});

describe('operational failure', () => {
  for (const skipped of ['gate_off', 'cooldown', 'durable_bell_failed', 'no_usable_phone']) {
    test(`${skipped} (no terminal flag) ⇒ the shell fallback still fires`, async () => {
      mockStartSmsThreadDraft.mockResolvedValue({ started: false, skipped });

      const result = await handleIntakeReply(CUSTOMER(), 'quarterly pest control please');

      expect(result).toEqual({ handled: true, next: 'estimate_drafted' });
      // A lead is never lost: the estimate was drafted and the owner told.
      expect(mockEstimateInserts.length).toBeGreaterThan(0);
      expect(mockSmsSends.length).toBeGreaterThan(0);
      expect(mockCustomerUpdates.some((p) => p.lead_intake_status === 'estimate_drafted')).toBe(true);
    });
  }

  test('a thrown handoff also falls back', async () => {
    mockStartSmsThreadDraft.mockRejectedValue(new Error('engine down'));

    const result = await handleIntakeReply(CUSTOMER(), 'quarterly pest control please');

    expect(result).toEqual({ handled: true, next: 'estimate_drafted' });
    expect(mockEstimateInserts.length).toBeGreaterThan(0);
  });
});

describe('successful handoff', () => {
  test('the engine owns the reply — no shell estimate, status advances', async () => {
    mockStartSmsThreadDraft.mockResolvedValue({ started: true, draftPromise: Promise.resolve({}) });

    const result = await handleIntakeReply(CUSTOMER(), 'quarterly pest control please');

    expect(result).toEqual({ handled: true, next: 'estimate_drafted' });
    expect(mockEstimateInserts).toHaveLength(0);
    expect(mockSmsSends).toHaveLength(0);
    expect(mockCustomerUpdates.some((p) => p.lead_intake_status === 'estimate_drafted')).toBe(true);
  });
});
