/**
 * The promise check at completion (visit-promises.js, owner "ok yes add
 * these" 2026-10-01): which promises are listed, how marks are validated
 * and resolved, the writer's PROMISES lines, and how Done / Partly reach the
 * office's promise list through its own paths.
 */

let mockCallLedger = true;
let mockSmsLedger = true;
let mockEmailLedger = true;
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return {
    ...actual,
    isEnabled: jest.fn((gate) => (gate === 'callCommitments' ? mockCallLedger : actual.isEnabled(gate))),
    gateEnvValue: jest.fn((name) => (name === 'GATE_EMAIL_OPERATIONAL_ACTIONS' ? mockEmailLedger : actual.gateEnvValue(name))),
  };
});
jest.mock('../services/call-commitments', () => ({
  listOpenCommitments: jest.fn(),
  applyHumanUpdate: jest.fn(),
}));
jest.mock('../services/sms-operational-actions', () => ({
  smsCommitmentsEnabled: jest.fn(() => mockSmsLedger),
  listSmsCommitments: jest.fn(),
  applySmsCommitmentUpdate: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const CallCommitments = require('../services/call-commitments');
const SmsActions = require('../services/sms-operational-actions');
const logger = require('../services/logger');
const VisitPromises = require('../services/service-report/visit-promises');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const CALL_ROW = {
  id: ID(1), party: 'waves', kind: 'technician_follow_up', description: 'Check under the  dishwasher and the kitchen sink',
  call_started_at: '2026-09-29T15:00:00Z', created_at: '2026-09-29T15:05:00Z',
};
const TEXT_ROW = {
  id: ID(2), party: 'waves', kind: 'other', description: 'Look at the gap under the garage door',
  channel: 'sms', sms_started_at: '2026-09-27T12:00:00Z',
};
const EMAIL_ROW = {
  id: ID(3), party: 'waves', kind: 'technician_follow_up', description: 'Recheck the attic vent',
  channel: 'email', sms_started_at: '2026-09-30T12:00:00Z',
};
const CUSTOMER_TODO = { id: ID(4), party: 'customer', kind: 'other', description: 'Send photos of the garage', channel: 'sms', sms_started_at: '2026-09-30T13:00:00Z' };
const OFFICE_TEXT = { id: ID(5), party: 'waves', kind: 'send_estimate', description: 'Send the estimate', channel: 'sms', sms_started_at: '2026-09-30T14:00:00Z' };

beforeEach(() => {
  jest.clearAllMocks();
  mockCallLedger = true;
  mockSmsLedger = true;
  mockEmailLedger = true;
  CallCommitments.listOpenCommitments.mockResolvedValue([CALL_ROW]);
  SmsActions.listSmsCommitments.mockResolvedValue([TEXT_ROW, EMAIL_ROW, CUSTOMER_TODO, OFFICE_TEXT]);
});

describe('the promises listed', () => {
  test('Waves promises a technician keeps, from calls, texts and emails, newest first', async () => {
    const promises = await VisitPromises.loadVisitPromises({}, { customerId: 'cust-1' });
    expect(promises).toEqual([
      { id: ID(3), description: 'Recheck the attic vent', source: 'email', madeAt: '2026-09-30T12:00:00.000Z' },
      { id: ID(1), description: 'Check under the dishwasher and the kitchen sink', source: 'call', madeAt: '2026-09-29T15:00:00.000Z' },
      { id: ID(2), description: 'Look at the gap under the garage door', source: 'text', madeAt: '2026-09-27T12:00:00.000Z' },
    ]);
    // Call rows are asked for the visit kinds and Waves' side only, as a pure read.
    expect(CallCommitments.listOpenCommitments).toHaveBeenCalledWith({}, expect.objectContaining({
      party: 'waves', kinds: ['technician_follow_up', 'other'], customerId: 'cust-1', prepare: false,
    }));
  });

  test('a source whose ledger is off is not listed', async () => {
    mockCallLedger = false;
    mockEmailLedger = false;
    const promises = await VisitPromises.loadVisitPromises({}, { customerId: 'cust-1' });
    expect(promises.map((promise) => promise.source)).toEqual(['text']);
    expect(CallCommitments.listOpenCommitments).not.toHaveBeenCalled();
  });

  test('no customer, no read', async () => {
    expect(await VisitPromises.loadVisitPromises({}, { customerId: null })).toEqual([]);
    expect(CallCommitments.listOpenCommitments).not.toHaveBeenCalled();
    expect(SmsActions.listSmsCommitments).not.toHaveBeenCalled();
  });

  test('the card lists the newest ten', async () => {
    CallCommitments.listOpenCommitments.mockResolvedValue(Array.from({ length: 14 }, (_, i) => ({
      ...CALL_ROW, id: ID(100 + i), call_started_at: `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00Z`,
    })));
    SmsActions.listSmsCommitments.mockResolvedValue([]);
    const promises = await VisitPromises.loadVisitPromises({}, { customerId: 'cust-1' });
    expect(promises).toHaveLength(VisitPromises.MAX_LISTED_PROMISES);
    expect(promises[0].id).toBe(ID(113));
  });
});

describe('marks from the request', () => {
  test('valid marks only, one per promise, a still-left note on Partly only', () => {
    expect(VisitPromises.promiseMarksFromBody([
      { id: ID(1), mark: 'done', stillLeft: 'ignored' },
      { id: ID(2), mark: 'partly', stillLeft: '  under the   kitchen sink ' },
      { id: 'not-a-uuid', mark: 'done' },
      { id: ID(3), mark: 'maybe' },
      { id: ID(1), mark: 'not_yet' },
    ])).toEqual([
      { id: ID(1), mark: 'not_yet' },
      { id: ID(2), mark: 'partly', stillLeft: 'under the kitchen sink' },
    ]);
    expect(VisitPromises.promiseMarksFromBody({ id: ID(1), mark: 'done' })).toEqual([]);
    expect(VisitPromises.promiseMarksFromBody([{ id: ID(2), mark: 'partly', stillLeft: 'x'.repeat(500) }])[0].stillLeft)
      .toHaveLength(VisitPromises.MAX_STILL_LEFT_CHARS);
  });

  test('a mark resolves only against a promise still open for this customer', async () => {
    const resolved = await VisitPromises.resolveVisitPromiseMarks({}, {
      customerId: 'cust-1',
      marks: [
        { id: ID(1), mark: 'done' },
        { id: ID(4), mark: 'done' }, // the customer's own to-do
        { id: ID(5), mark: 'done' }, // office work
        { id: ID(9), mark: 'done' }, // closed since, or never this customer's
      ],
    });
    expect(resolved).toEqual([
      { id: ID(1), mark: 'done', description: 'Check under the dishwasher and the kitchen sink', source: 'call' },
    ]);
  });

  test('access codes never reach the writer, in the promise or the still-left note', () => {
    const [line] = VisitPromises.writerPromiseLines([
      { mark: 'partly', description: 'Check the side yard, gate code 4821', stillLeft: 'the shed, lockbox code 1234' },
    ]);
    expect(line).not.toMatch(/4821|1234/);
    expect(line).toContain('[redacted]');
  });

  test("the writer's PROMISES lines say each promise as marked", () => {
    expect(VisitPromises.writerPromiseLines([
      { mark: 'done', description: 'Check under the dishwasher' },
      { mark: 'partly', description: 'Look at the gap under the garage door', stillLeft: 'seal the left side' },
      { mark: 'not_yet', description: 'Recheck the attic vent' },
    ])).toEqual([
      '- Done today: Check under the dishwasher',
      '- Partly done today: Look at the gap under the garage door (still left: seal the left side)',
      '- Not done yet: Recheck the attic vent',
    ]);
  });
});

describe('the scope', () => {
  test.each([
    ['Quarterly Pest Control', { serviceKey: 'pest_general_quarterly', findingsType: null }, true],
    ['Pest Re-Service', { serviceKey: 'pest_re_service', findingsType: null }, true],
    ['Lawn Care', { serviceKey: 'lawn_care_monthly', findingsType: null }, false],
    ['Tree & Shrub', { serviceKey: 'tree_shrub_quarterly', findingsType: 'tree_shrub' }, false],
    ['Palm Injection', { serviceKey: 'palm_treatment', findingsType: 'palm_injection' }, false],
  ])('%s → %s (the writer\'s own scope)', (serviceType, profile, expected) => {
    expect(VisitPromises.promiseCheckInScope(serviceType, profile)).toBe(expected);
  });
});

function noteDb(rows) {
  const updates = [];
  const trx = (table) => {
    const state = { id: null };
    const chain = {
      where: (criteria) => { state.id = criteria.id; return chain; },
      forUpdate: () => chain,
      first: async () => (table === 'call_commitments' ? rows[state.id] || null : null),
      update: async (patch) => { updates.push({ id: state.id, patch }); rows[state.id] = { ...rows[state.id], ...patch }; return 1; },
    };
    return chain;
  };
  return { conn: { transaction: (fn) => fn(trx) }, updates };
}

describe('marks reach the office list after the save', () => {
  test('Done closes a call promise and a text promise through the office paths, naming the visit', async () => {
    const { conn } = noteDb({});
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1',
      marks: [{ id: ID(1), mark: 'done' }, { id: ID(2), mark: 'done' }],
      visitDate: '2026-10-01',
      reviewedBy: 'tech-1',
    });
    const note = 'Done at the October 1 visit (marked by the technician).';
    expect(CallCommitments.applyHumanUpdate).toHaveBeenCalledWith(conn, ID(1), { action: 'fulfill', note, reviewedBy: 'tech-1' });
    expect(SmsActions.applySmsCommitmentUpdate).toHaveBeenCalledWith(conn, ID(2), {
      customerId: 'cust-1', action: 'fulfill', note, reviewedBy: 'tech-1',
    });
    expect(results).toEqual([
      { id: ID(1), mark: 'done', applied: true },
      { id: ID(2), mark: 'done', applied: true },
    ]);
  });

  test('Partly keeps the promise open with the still-left note, added once', async () => {
    const rows = { [ID(2)]: { status: 'open', human_note: 'Customer prefers mornings' } };
    const { conn, updates } = noteDb(rows);
    const args = { customerId: 'cust-1', marks: [{ id: ID(2), mark: 'partly', stillLeft: 'seal the left side' }], visitDate: '2026-10-01' };
    await VisitPromises.applyVisitPromiseMarks(conn, args);
    await VisitPromises.applyVisitPromiseMarks(conn, args); // a resumed completion
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.human_note).toBe('Customer prefers mornings\nPartly done at the October 1 visit. Still left: seal the left side.');
    expect(updates[0].patch).not.toHaveProperty('status');
    expect(CallCommitments.applyHumanUpdate).not.toHaveBeenCalled();
    expect(SmsActions.applySmsCommitmentUpdate).not.toHaveBeenCalled();
  });

  test('Not yet changes nothing, and one failure leaves the others applied', async () => {
    CallCommitments.applyHumanUpdate.mockRejectedValueOnce(new Error('Commitment not found'));
    const { conn, updates } = noteDb({});
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1',
      marks: [{ id: ID(1), mark: 'done' }, { id: ID(2), mark: 'done' }, { id: ID(3), mark: 'not_yet' }],
      visitDate: '2026-10-01',
    });
    expect(results).toEqual([
      { id: ID(1), mark: 'done', applied: false },
      { id: ID(2), mark: 'done', applied: true },
    ]);
    expect(updates).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`mark not applied for promise ${ID(1)}`));
  });

  test('a promise no longer open is left alone', async () => {
    CallCommitments.listOpenCommitments.mockResolvedValue([]);
    const { conn } = noteDb({});
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done' }], visitDate: '2026-10-01',
    });
    expect(results).toEqual([]);
    expect(CallCommitments.applyHumanUpdate).not.toHaveBeenCalled();
  });
});

// House style: the giant completion file is pinned by source; the behavior
// is tested above through the service it delegates to.
describe('wiring source contracts', () => {
  const fs = require('fs');
  const path = require('path');
  const completionSource = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

  test('completion applies the marks POST-COMMIT, fail-soft, before the response payload', () => {
    const call = completionSource.indexOf('VisitPromises.applyVisitPromiseMarks(db, {');
    expect(call).toBeGreaterThan(completionSource.indexOf('durableCompletionCommitted = true;'));
    expect(completionSource.indexOf('const responsePayload = {', call)).toBeGreaterThan(call);
    const block = completionSource.slice(completionSource.lastIndexOf('if (!isBackfillCompletion', call), call + 400);
    expect(block).toMatch(/Array\.isArray\(promiseMarks\) && promiseMarks\.length/);
    expect(block).toMatch(/reportWriterRulesLive\(\)/);
    expect(block).toMatch(/effectiveCompletionProfile && VisitPromises\.promiseCheckInScope\(svc\.service_type, effectiveCompletionProfile\)/);
    const catchBody = block.slice(block.indexOf('catch (promiseErr)'));
    expect(catchBody).toMatch(/logger\.warn/);
    expect(catchBody).not.toMatch(/res\.status|throw/);
    // One call site: the completed exit only (an incomplete visit keeps its promises open).
    expect(completionSource.split('applyVisitPromiseMarks(').length - 1).toBe(1);
  });

  test('the generate route reads marks only with the writer rules on a grounded visit', () => {
    expect(routeSource).toMatch(/if \(writerRulesOn && groundingCustomerId && Array\.isArray\(promiseMarks\) && promiseMarks\.length\) \{/);
    expect(routeSource).toMatch(/visitPromises,\n\s+\}\);/);
  });
});

