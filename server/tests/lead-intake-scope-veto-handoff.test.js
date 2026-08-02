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
// An open unpriced intake shell for the customer, when set — the branch
// that used to bypass the scope guards entirely.
let mockShellRow;
let mockEstimateUpdates;

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
      async first() {
        if (table === 'estimates') return mockShellRow;
        return null;
      },
      async update(patch) {
        if (table === 'customers') mockCustomerUpdates.push(patch);
        if (table === 'estimates') mockEstimateUpdates.push(patch);
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
  mockShellRow = null;
  mockEstimateUpdates = [];
  mockClassify.mockResolvedValue({ interest: 'pest', method: 'regex' });
});

describe('terminal scope veto', () => {
  for (const skipped of ['out_of_scope_service', 'out_of_scope_service_thread', 'no_quote_intent_ai_out_of_scope', 'no_quote_intent_ai_existing_job']) {
    test(`${skipped} ⇒ handled, no estimate, no owner alert, status unchanged`, async () => {
      mockStartSmsThreadDraft.mockResolvedValue({ started: false, skipped, terminal: true });

      const result = await handleIntakeReply(CUSTOMER(), 'power wash my yard');

      expect(result.handled).toBe(true);
      // terminal:true is what stops the webhook from swallowing the
      // message: a refusal to QUOTE must not also suppress the inbound
      // bell/push/owner-forward for what may be a service instruction.
      expect(result.terminal).toBe(true);
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

describe('address-LESS replies get the scope check BEFORE anything records', () => {
  const ADDRESSLESS = () => ({
    id: 'cust-1',
    phone: '+19415550123',
    address_line1: '',
    lead_intake_status: 'awaiting_service',
  });

  test('address-less terminal veto ⇒ nothing recorded, no stage advance, no clarify', async () => {
    // The refusal used to live inside if(hasAddress): an address-less
    // 'power wash my yard' recorded lawn interest, advanced to
    // awaiting_address, and parked an address clarification.
    mockStartSmsThreadDraft.mockResolvedValue({ started: false, skipped: 'out_of_scope_service', terminal: true });

    const result = await handleIntakeReply(ADDRESSLESS(), 'power wash my yard');

    expect(mockStartSmsThreadDraft).toHaveBeenCalledWith(expect.objectContaining({ scopeCheckOnly: true }));
    // terminal:true keeps the inbound message flowing to the normal
    // bell/push/owner-forward — refusing to QUOTE must not silence it.
    expect(result).toEqual({ handled: true, terminal: true, next: 'awaiting_service' });
    // NO writes of any kind: no interest, no stage, no estimate, no alert.
    expect(mockCustomerUpdates).toHaveLength(0);
    expect(mockEstimateInserts).toHaveLength(0);
    expect(mockEstimateUpdates).toHaveLength(0);
    expect(mockSmsSends).toHaveLength(0);
  });

  test('address-less in-scope reply still records interest and advances to awaiting_address', async () => {
    mockStartSmsThreadDraft.mockResolvedValue({ started: false, skipped: 'scope_check_only' });

    const result = await handleIntakeReply(ADDRESSLESS(), 'quarterly pest control please');

    expect(result).toEqual({ handled: false });
    expect(mockCustomerUpdates.some((p) => p.lead_service_interest)).toBe(true);
    expect(mockCustomerUpdates.some((p) => p.lead_intake_status === 'awaiting_address')).toBe(true);
  });
});

describe('single-pass ladder: the pre-check verdict threads into the real run', () => {
  test('in-scope + address: one scopeCheckOnly call, then one full call reusing its triage', async () => {
    const SENTINEL = { lines: [], matchedExistingCustomer: false, sentinel: true };
    mockStartSmsThreadDraft.mockImplementation(async (args) => (args.scopeCheckOnly
      ? { started: false, skipped: 'scope_check_only', triage: SENTINEL }
      : { started: true, draftPromise: Promise.resolve({}) }));

    const result = await handleIntakeReply(CUSTOMER(), 'quarterly pest control please');

    expect(result).toEqual({ handled: true, next: 'estimate_drafted' });
    expect(mockStartSmsThreadDraft).toHaveBeenCalledTimes(2);
    expect(mockStartSmsThreadDraft.mock.calls[0][0]).toEqual(expect.objectContaining({ scopeCheckOnly: true }));
    const second = mockStartSmsThreadDraft.mock.calls[1][0];
    expect(second.scopeCheckOnly).toBeUndefined();
    // The pre-check's triage rides into the real run — startSmsThreadDraft
    // skips its whole veto/triage/classifier ladder on a precomputedTriage
    // (pinned in the sms-thread suite), so the ladder ran exactly ONCE.
    expect(second.precomputedTriage).toBe(SENTINEL);
  });
});

describe('awaiting_address replies get the scope check BEFORE any persist', () => {
  const ADDR_CUSTOMER = () => ({
    id: 'cust-1',
    phone: '+19415550123',
    address_line1: '',
    lead_service_interest: 'pest',
    lead_intake_status: 'awaiting_address',
  });
  const BODY = '100 Palm Ave — actually looking for power washing';

  test('terminal veto ⇒ no address write, no clarify stamp, no estimate, no alert', async () => {
    mockStartSmsThreadDraft.mockResolvedValue({ started: false, skipped: 'out_of_scope_service', terminal: true });

    const result = await handleIntakeReply(ADDR_CUSTOMER(), BODY);

    expect(result).toEqual({ handled: true, terminal: true, next: 'awaiting_address' });
    expect(mockCustomerUpdates.some((p) => 'address_line1' in p)).toBe(false);
    expect(mockCustomerUpdates).toHaveLength(0);
    expect(mockEstimateInserts).toHaveLength(0);
    expect(mockEstimateUpdates).toHaveLength(0);
    expect(mockSmsSends).toHaveLength(0);
  });

  test('in-scope address reply still persists and drafts', async () => {
    const SENTINEL = { lines: [], matchedExistingCustomer: false };
    mockStartSmsThreadDraft.mockImplementation(async (args) => (args.scopeCheckOnly
      ? { started: false, skipped: 'scope_check_only', triage: SENTINEL }
      : { started: true, draftPromise: Promise.resolve({}) }));

    const result = await handleIntakeReply(ADDR_CUSTOMER(), '100 Palm Ave, Venice FL 34285');

    expect(result).toEqual({ handled: true, next: 'estimate_drafted' });
    expect(mockCustomerUpdates.some((p) => p.address_line1 === '100 Palm Ave, Venice FL 34285')).toBe(true);
    expect(mockStartSmsThreadDraft.mock.calls[1][0].precomputedTriage).toBe(SENTINEL);
  });
});

describe('open-shell branch still runs the scope check', () => {
  const SHELL = { id: 'shell-est-1', address: '', customer_phone: '+19415550123', customer_email: null };

  test('shell + terminal veto ⇒ no patch, no stamp, no owner alert', async () => {
    mockShellRow = SHELL;
    mockStartSmsThreadDraft.mockResolvedValue({ started: false, skipped: 'out_of_scope_service', terminal: true });

    const result = await handleIntakeReply(CUSTOMER(), 'power wash my yard');

    // The engine was consulted in scope-check-only mode (no bell/draft).
    expect(mockStartSmsThreadDraft).toHaveBeenCalledWith(expect.objectContaining({ scopeCheckOnly: true }));
    expect(result.handled).toBe(true);
    expect(mockEstimateUpdates).toHaveLength(0);
    expect(mockEstimateInserts).toHaveLength(0);
    expect(mockSmsSends).toHaveLength(0);
    expect(mockCustomerUpdates.some((p) => p.lead_intake_status === 'estimate_drafted')).toBe(false);
  });

  test('shell + in-scope reply ⇒ the legacy shell patch proceeds', async () => {
    mockShellRow = SHELL;
    mockStartSmsThreadDraft.mockResolvedValue({ started: false, skipped: 'scope_check_only' });

    const result = await handleIntakeReply(CUSTOMER(), 'quarterly pest control please');

    expect(result).toEqual({ handled: true, next: 'estimate_drafted' });
    // The shell was PATCHED (not a new insert), the owner told, the state
    // advanced — exactly the pre-existing shell behavior.
    expect(mockEstimateUpdates.length).toBeGreaterThan(0);
    expect(mockEstimateInserts).toHaveLength(0);
    expect(mockSmsSends.length).toBeGreaterThan(0);
    expect(mockCustomerUpdates.some((p) => p.lead_intake_status === 'estimate_drafted')).toBe(true);
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
