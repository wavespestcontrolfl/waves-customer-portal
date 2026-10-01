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
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n-1' })) }));
jest.mock('../services/admin-alert-episodes', () => ({ closeAdminAlertKeys: jest.fn(async () => 1) }));

const CallCommitments = require('../services/call-commitments');
const SmsActions = require('../services/sms-operational-actions');
const logger = require('../services/logger');
const VisitPromises = require('../services/service-report/visit-promises');

const ID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const V = (description, reviewedAt = null) => VisitPromises.promiseVersion(description, reviewedAt);
// A read-only handle for the listing: the office's last verdict on each
// promise (reviewed_at), none by default.
function listDb(reviewed = {}) {
  return (table) => ({
    whereIn: (_col, ids) => ({
      select: async () => (table === 'call_commitments' ? ids.map((id) => ({ id, reviewed_at: reviewed[id] || null })) : []),
    }),
  });
}
const LIST_DB = listDb();

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
    const { promises, total } = await VisitPromises.loadVisitPromises(LIST_DB, { customerId: 'cust-1' });
    expect(promises).toEqual([
      { id: ID(3), description: 'Recheck the attic vent', source: 'email', madeAt: '2026-09-30T12:00:00.000Z', version: V('Recheck the attic vent') },
      { id: ID(1), description: 'Check under the dishwasher and the kitchen sink', source: 'call', madeAt: '2026-09-29T15:00:00.000Z', version: V('Check under the dishwasher and the kitchen sink') },
      { id: ID(2), description: 'Look at the gap under the garage door', source: 'text', madeAt: '2026-09-27T12:00:00.000Z', version: V('Look at the gap under the garage door') },
    ]);
    expect(total).toBe(3);
    // Call rows are asked for the visit kinds and Waves' side only, as a pure read.
    expect(CallCommitments.listOpenCommitments).toHaveBeenCalledWith(LIST_DB, expect.objectContaining({
      party: 'waves', kinds: ['technician_follow_up', 'other'], customerId: 'cust-1', prepare: false,
    }));
  });

  test('a source whose ledger is off is not listed', async () => {
    mockCallLedger = false;
    mockEmailLedger = false;
    const { promises } = await VisitPromises.loadVisitPromises(LIST_DB, { customerId: 'cust-1' });
    expect(promises.map((promise) => promise.source)).toEqual(['text']);
    expect(CallCommitments.listOpenCommitments).not.toHaveBeenCalled();
  });

  test('no customer, no read', async () => {
    expect(await VisitPromises.loadVisitPromises(LIST_DB, { customerId: null })).toEqual({ promises: [], total: 0 });
    expect(CallCommitments.listOpenCommitments).not.toHaveBeenCalled();
    expect(SmsActions.listSmsCommitments).not.toHaveBeenCalled();
  });

  test('a long promise is listed in full: the tech sees everything Done would close', async () => {
    const long = `Check under the dishwasher, ${'and every cabinet along that wall, '.repeat(15)}then the sink.`;
    CallCommitments.listOpenCommitments.mockResolvedValue([{ ...CALL_ROW, description: long }]);
    SmsActions.listSmsCommitments.mockResolvedValue([]);
    const { promises } = await VisitPromises.loadVisitPromises(LIST_DB, { customerId: 'cust-1' });
    expect(long.length).toBeGreaterThan(300);
    expect(promises[0].description).toBe(long);
    expect(promises[0].version).toBe(V(long));
  });

  test('every page of both ledgers is read, so the newest promise is never cut off', async () => {
    // The readers order overdue and oldest first, 200 to a page; the text
    // reader's pages also carry customer and office rows.
    const old = (i) => ({ ...CALL_ROW, id: ID(1000 + i), call_started_at: '2026-01-01T12:00:00Z' });
    CallCommitments.listOpenCommitments.mockImplementation(async (_conn, { limit, offset }) => (
      offset === 0 ? Array.from({ length: limit }, (_, i) => old(i)) : [{ ...CALL_ROW, id: ID(7), call_started_at: '2026-09-30T18:00:00Z' }]
    ));
    SmsActions.listSmsCommitments.mockImplementation(async (_conn, { limit, offset }) => (
      offset === 0 ? Array.from({ length: limit }, () => CUSTOMER_TODO) : [TEXT_ROW]
    ));
    const { promises, total } = await VisitPromises.loadVisitPromises(LIST_DB, { customerId: 'cust-1' });
    expect(promises[0].id).toBe(ID(7));
    expect(promises.some((promise) => promise.id === ID(2))).toBe(true);
    expect(total).toBe(202);
    expect(CallCommitments.listOpenCommitments).toHaveBeenCalledWith(LIST_DB, expect.objectContaining({ limit: 200, offset: 200 }));
    expect(SmsActions.listSmsCommitments).toHaveBeenCalledWith(LIST_DB, { customerId: 'cust-1', limit: 200, offset: 200 });
  });

  test('the card lists the newest ten', async () => {
    CallCommitments.listOpenCommitments.mockResolvedValue(Array.from({ length: 14 }, (_, i) => ({
      ...CALL_ROW, id: ID(100 + i), call_started_at: `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00Z`,
    })));
    SmsActions.listSmsCommitments.mockResolvedValue([]);
    const { promises, total } = await VisitPromises.loadVisitPromises(LIST_DB, { customerId: 'cust-1' });
    expect(promises).toHaveLength(VisitPromises.MAX_LISTED_PROMISES);
    expect(total).toBe(14);
    expect(promises[0].id).toBe(ID(113));
  });
});

describe('marks from the request', () => {
  test('valid marks only, one per promise, each with the wording version, a still-left note on Partly only', () => {
    const v = V('anything');
    expect(VisitPromises.promiseMarksFromBody([
      { id: ID(1), mark: 'done', version: v, stillLeft: 'ignored' },
      { id: ID(2), mark: 'partly', version: v, stillLeft: '  under the   kitchen sink ' },
      { id: 'not-a-uuid', mark: 'done', version: v },
      { id: ID(3), mark: 'maybe', version: v },
      { id: ID(4), mark: 'done' }, // no version: the wording seen is unknown
      { id: ID(5), mark: 'partly', version: v, stillLeft: '   ' }, // Partly with nothing left named
      { id: ID(1), mark: 'not_yet', version: v },
    ])).toEqual([
      { id: ID(1), mark: 'not_yet', version: v },
      { id: ID(2), mark: 'partly', version: v, stillLeft: 'under the kitchen sink' },
    ]);
    expect(VisitPromises.promiseMarksFromBody({ id: ID(1), mark: 'done', version: v })).toEqual([]);
    expect(VisitPromises.promiseMarksFromBody([{ id: ID(2), mark: 'partly', version: v, stillLeft: 'x'.repeat(500) }])[0].stillLeft)
      .toHaveLength(VisitPromises.MAX_STILL_LEFT_CHARS);
  });

  test('a mark resolves only against a promise still open for this customer', async () => {
    const resolved = await VisitPromises.resolveVisitPromiseMarks(LIST_DB, {
      customerId: 'cust-1',
      marks: [
        { id: ID(1), mark: 'done', version: V(CALL_ROW.description) },
        { id: ID(2), mark: 'done', version: V('Look at the old gap wording') }, // reworded since
        { id: ID(4), mark: 'done', version: V(CUSTOMER_TODO.description) }, // the customer's own to-do
        { id: ID(5), mark: 'done', version: V(OFFICE_TEXT.description) }, // office work
        { id: ID(9), mark: 'done', version: V('x') }, // closed since, or never this customer's
      ],
    });
    expect(resolved).toEqual([
      { id: ID(1), mark: 'done', version: V(CALL_ROW.description), description: 'Check under the dishwasher and the kitchen sink', source: 'call' },
    ]);
  });

  test('access codes never reach the writer, in the promise or the still-left note', () => {
    const [line] = VisitPromises.writerPromiseLines([
      { mark: 'partly', description: 'Check the side yard, gate code 4821', stillLeft: 'the shed, lockbox code 1234' },
    ]);
    expect(line).not.toMatch(/4821|1234/);
    expect(line).toContain('[redacted]');
  });

  test('a mark that no longer holds is reported as changed', async () => {
    const stale = await VisitPromises.staleVisitPromiseMarks(LIST_DB, {
      customerId: 'cust-1',
      marks: [
        { id: ID(1), mark: 'done', version: V(CALL_ROW.description) }, // still open, same wording
        { id: ID(2), mark: 'done', version: V('the old wording') }, // reworded since
        { id: ID(9), mark: 'not_yet', version: V('x') }, // closed since
      ],
    });
    expect(stale).toEqual([ID(2), ID(9)]);
  });

  test('a promise the office reopened (or otherwise settled) since the tech saw it is stale, even in the same words', async () => {
    const reopened = listDb({ [ID(1)]: '2026-10-01T09:00:00Z' });
    expect(await VisitPromises.staleVisitPromiseMarks(reopened, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }],
    })).toEqual([ID(1)]);
    // Marked against the promise as it now stands, the mark holds.
    expect(await VisitPromises.staleVisitPromiseMarks(reopened, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description, '2026-10-01T09:00:00Z') }],
    })).toEqual([]);
  });

  test('a restored mark on an older promise is listed after the newest ten when asked for', async () => {
    CallCommitments.listOpenCommitments.mockResolvedValue(Array.from({ length: 14 }, (_, i) => ({
      ...CALL_ROW, id: ID(100 + i), call_started_at: `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00Z`,
    })));
    SmsActions.listSmsCommitments.mockResolvedValue([]);
    const { promises, total } = await VisitPromises.loadVisitPromises(LIST_DB, { customerId: 'cust-1', include: [ID(100), 'not-a-uuid', ID(999)] });
    expect(promises).toHaveLength(VisitPromises.MAX_LISTED_PROMISES + 1);
    expect(promises[promises.length - 1].id).toBe(ID(100));
    expect(total).toBe(14);
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

// A ledger under locks: customers, each promise's source row, the promise.
function ledgerDb({ customers = ['cust-1'], commitments = {}, sources = {} } = {}) {
  const updates = [];
  const locks = [];
  const trx = (table) => {
    const state = { criteria: {}, lock: null };
    const chain = {
      where: (criteria) => { Object.assign(state.criteria, criteria); return chain; },
      whereNull: () => chain,
      whereIn: (_col, ids) => { state.ids = ids; return chain; },
      select: async () => (state.ids || []).map((id) => ({ id, reviewed_at: commitments[id]?.reviewed_at || null })),
      forShare: () => { state.lock = 'share'; return chain; },
      forUpdate: () => { state.lock = 'update'; return chain; },
      first: async () => {
        if (state.lock) locks.push(`${table}:${state.lock}`);
        if (table === 'customers') return customers.includes(state.criteria.id) ? { id: state.criteria.id } : null;
        if (table === 'call_commitments') return commitments[state.criteria.id] ? { ...commitments[state.criteria.id] } : null;
        return sources[`${table}:${state.criteria.id}`] || null;
      },
      update: async (patch) => {
        updates.push({ id: state.criteria.id, patch });
        commitments[state.criteria.id] = { ...commitments[state.criteria.id], ...patch };
        return 1;
      },
    };
    return chain;
  };
  const conn = Object.assign((table) => trx(table), { transaction: (fn) => fn(trx) });
  return { conn, updates, locks };
}

const LEDGER = () => ({
  commitments: {
    [ID(1)]: { status: 'open', party: 'waves', kind: 'technician_follow_up', call_log_id: 'call-1', description: CALL_ROW.description },
    [ID(2)]: { status: 'open', party: 'waves', kind: 'other', sms_log_id: 'sms-1', description: TEXT_ROW.description, human_note: 'Customer prefers mornings' },
  },
  sources: { 'call_log:call-1': { customer_id: 'cust-1' }, 'sms_log:sms-1': { customer_id: 'cust-1' } },
});

describe('marks reach the office list after the save', () => {
  test('Done closes a call promise and a text promise through the office paths, naming the visit', async () => {
    const { conn, locks } = ledgerDb(LEDGER());
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1',
      marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }, { id: ID(2), mark: 'done', version: V(TEXT_ROW.description) }],
      visitDate: '2026-10-01',
      reviewedBy: 'tech-1',
    });
    const note = 'Done at the October 1 visit (marked by the technician).';
    expect(CallCommitments.applyHumanUpdate).toHaveBeenCalledWith(expect.any(Function), ID(1), { action: 'fulfill', note, reviewedBy: 'tech-1' });
    // A text promise is checked under the office path's own lock strength,
    // then written by that path inside the same transaction.
    // The office's own note stays, with the visit's line under it.
    expect(SmsActions.applySmsCommitmentUpdate).toHaveBeenCalledWith(expect.any(Function), ID(2), {
      customerId: 'cust-1', action: 'fulfill', note: `Customer prefers mornings\n${note}`, reviewedBy: 'tech-1',
    });
    expect(results).toEqual([
      { id: ID(1), mark: 'done', applied: true },
      { id: ID(2), mark: 'done', applied: true },
    ]);
    // Each promise is re-checked under locks first: customer, source, promise.
    expect(locks).toEqual([
      'customers:share', 'call_log:share', 'call_commitments:update',
      'customers:update', 'sms_log:update', 'call_commitments:update',
    ]);
  });

  test('Done is not written when the call moved to another customer or the office settled the promise meanwhile', async () => {
    const moved = LEDGER();
    moved.sources['call_log:call-1'] = { customer_id: 'cust-2' };
    const movedDb = ledgerDb(moved);
    const movedResults = await VisitPromises.applyVisitPromiseMarks(movedDb.conn, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }], visitDate: '2026-10-01',
    });
    expect(movedResults).toEqual([{ id: ID(1), mark: 'done', applied: false }]);

    const settled = LEDGER();
    settled.commitments[ID(1)].status = 'dismissed';
    const settledDb = ledgerDb(settled);
    const settledResults = await VisitPromises.applyVisitPromiseMarks(settledDb.conn, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }], visitDate: '2026-10-01',
    });
    expect(settledResults).toEqual([{ id: ID(1), mark: 'done', applied: false }]);
    expect(CallCommitments.applyHumanUpdate).not.toHaveBeenCalled();
  });

  test('Partly keeps the promise open with the still-left note, added once', async () => {
    const { conn, updates } = ledgerDb(LEDGER());
    const args = { customerId: 'cust-1', marks: [{ id: ID(2), mark: 'partly', version: V(TEXT_ROW.description), stillLeft: 'seal the left side' }], visitDate: '2026-10-01' };
    await VisitPromises.applyVisitPromiseMarks(conn, args);
    await VisitPromises.applyVisitPromiseMarks(conn, args); // a resumed completion
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.human_note).toBe('Customer prefers mornings\nPartly done at the October 1 visit. Still left: seal the left side.');
    // A person's verdict: the automatic checks (evidence close, contact
    // check, a call reprocess) leave a reviewed row alone. The office's
    // verdict time is untouched (Codex #5516).
    expect(updates[0].patch.human_state).toBe('confirmed');
    expect(updates[0].patch).not.toHaveProperty('reviewed_at');
    expect(updates[0].patch).not.toHaveProperty('status');
    expect(CallCommitments.applyHumanUpdate).not.toHaveBeenCalled();
    expect(SmsActions.applySmsCommitmentUpdate).not.toHaveBeenCalled();
  });

  test('Done is not written when the office reworded the promise meanwhile', async () => {
    const reworded = LEDGER();
    reworded.commitments[ID(1)].description = 'Check under the dishwasher only';
    // The listing still shows the old wording (the card's snapshot)…
    const { conn } = ledgerDb(reworded);
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }], visitDate: '2026-10-01',
    });
    // …but the locked row reads differently, so nothing is written.
    expect(results).toEqual([{ id: ID(1), mark: 'done', applied: false }]);
    expect(CallCommitments.applyHumanUpdate).not.toHaveBeenCalled();
  });

  test('Done on a promise the office reopened meanwhile writes nothing', async () => {
    const ledger = LEDGER();
    ledger.commitments[ID(1)].reviewed_at = '2026-10-01T09:00:00Z';
    const { conn } = ledgerDb(ledger);
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }], visitDate: '2026-10-01',
    });
    expect(results).toEqual([]);
    expect(CallCommitments.applyHumanUpdate).not.toHaveBeenCalled();
  });

  test("Done leaves an office note too full for the visit's line as it is", async () => {
    const ledger = LEDGER();
    ledger.commitments[ID(1)].human_note = 'x'.repeat(1990);
    const { conn } = ledgerDb(ledger);
    await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }], visitDate: '2026-10-01', reviewedBy: 'tech-1',
    });
    expect(CallCommitments.applyHumanUpdate).toHaveBeenCalledWith(expect.any(Function), ID(1), { action: 'fulfill', note: undefined, reviewedBy: 'tech-1' });
  });

  test('a Partly note already on the promise (a resumed completion) counts as saved', async () => {
    const ledger = LEDGER();
    ledger.commitments[ID(2)].human_note = 'Customer prefers mornings\nPartly done at the October 1 visit. Still left: the left side.';
    const { conn, updates } = ledgerDb(ledger);
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(2), mark: 'partly', version: V(TEXT_ROW.description), stillLeft: 'the left side' }], visitDate: '2026-10-01',
    });
    expect(results).toEqual([{ id: ID(2), mark: 'partly', applied: true }]);
    // The retry still marks the row reviewed; the note is not written twice.
    expect(updates).toEqual([{ id: ID(2), patch: { human_state: 'confirmed', updated_at: expect.any(Date) } }]);
  });

  test("Partly keeps the office's own review state", async () => {
    const ledger = LEDGER();
    ledger.commitments[ID(2)].human_state = 'edited';
    const { conn, updates } = ledgerDb(ledger);
    await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(2), mark: 'partly', version: V(TEXT_ROW.description), stillLeft: 'the left side' }], visitDate: '2026-10-01',
    });
    expect(updates[0].patch.human_state).toBe('edited');
  });

  test("Partly never cuts the office's own note to make room", async () => {
    const full = LEDGER();
    full.commitments[ID(2)].human_note = 'x'.repeat(1990);
    const { conn, updates } = ledgerDb(full);
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(2), mark: 'partly', version: V(TEXT_ROW.description), stillLeft: 'seal the left side' }], visitDate: '2026-10-01',
    });
    expect(results).toEqual([{ id: ID(2), mark: 'partly', applied: false }]);
    // No line, but the technician's verdict still keeps the automatic
    // checks off the promise until the office settles it.
    expect(updates).toEqual([{ id: ID(2), patch: { human_state: 'confirmed', updated_at: expect.any(Date) } }]);
  });

  test('Partly adds no note once the text belongs to another customer', async () => {
    const moved = LEDGER();
    moved.sources['sms_log:sms-1'] = { customer_id: 'cust-2' };
    const { conn, updates } = ledgerDb(moved);
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(2), mark: 'partly', version: V(TEXT_ROW.description), stillLeft: 'x' }], visitDate: '2026-10-01',
    });
    expect(results).toEqual([{ id: ID(2), mark: 'partly', applied: false }]);
    expect(updates).toEqual([]);
  });

  test('Not yet keeps the promise open against the automatic checks, and one failure leaves the others applied', async () => {
    CallCommitments.applyHumanUpdate.mockRejectedValueOnce(new Error('Commitment not found'));
    const ledger = LEDGER();
    ledger.commitments[ID(3)] = { status: 'open', party: 'waves', kind: 'technician_follow_up', email_id: 'email-1', description: EMAIL_ROW.description };
    ledger.sources['emails:email-1'] = { customer_id: 'cust-1' };
    const { conn, updates } = ledgerDb(ledger);
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1',
      marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }, { id: ID(2), mark: 'done', version: V(TEXT_ROW.description) }, { id: ID(3), mark: 'not_yet', version: V(EMAIL_ROW.description) }],
      visitDate: '2026-10-01',
    });
    expect(results).toEqual([
      { id: ID(1), mark: 'done', applied: false },
      { id: ID(2), mark: 'done', applied: true },
      { id: ID(3), mark: 'not_yet', applied: true },
    ]);
    // Not yet writes only the review state: still open, no note, the
    // office's verdict time untouched (Codex #5516).
    expect(updates).toEqual([{ id: ID(3), patch: { human_state: 'confirmed', updated_at: expect.any(Date) } }]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`mark not applied for promise ${ID(1)}`));
  });

  test("a failed write logs the promise and an error code, never the database's message (it can carry a note)", async () => {
    const leak = Object.assign(new Error('update "call_commitments" set "human_note" = $1 - Customer prefers mornings, gate 4417'), { code: '57014' });
    CallCommitments.applyHumanUpdate.mockRejectedValueOnce(leak);
    const { conn } = ledgerDb(LEDGER());
    await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }], visitDate: '2026-10-01',
    });
    expect(logger.warn).toHaveBeenCalledWith(`[visit-promises] mark not applied for promise ${ID(1)} (57014)`);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/prefers mornings|4417/);
  });

  test('Not yet on a promise the office already reviewed writes nothing', async () => {
    const ledger = LEDGER();
    ledger.commitments[ID(1)].human_state = 'confirmed';
    const { conn, updates } = ledgerDb(ledger);
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'not_yet', version: V(CALL_ROW.description) }], visitDate: '2026-10-01',
    });
    expect(results).toEqual([{ id: ID(1), mark: 'not_yet', applied: true }]);
    expect(updates).toEqual([]);
  });

  test('a promise no longer open is left alone', async () => {
    CallCommitments.listOpenCommitments.mockResolvedValue([]);
    const { conn } = ledgerDb(LEDGER());
    const results = await VisitPromises.applyVisitPromiseMarks(conn, {
      customerId: 'cust-1', marks: [{ id: ID(1), mark: 'done', version: V(CALL_ROW.description) }], visitDate: '2026-10-01',
    });
    expect(results).toEqual([]);
    expect(CallCommitments.applyHumanUpdate).not.toHaveBeenCalled();
  });
});

// House style: the giant completion file is pinned by source; the behavior
// is tested above through the service it delegates to.
describe('marks that did not reach the list', () => {
  const marks = [
    { id: ID(1), mark: 'done', version: V(CALL_ROW.description) },
    { id: ID(2), mark: 'partly', version: V(TEXT_ROW.description), stillLeft: 'the left side' },
    { id: ID(3), mark: 'not_yet', version: V(EMAIL_ROW.description) },
  ];

  test('a Done promise still open, and a Partly one without its line, are unsaved; Not yet never is', async () => {
    const unsaved = await VisitPromises.unsavedVisitPromiseMarks(LIST_DB, {
      customerId: 'cust-1', marks, results: [{ id: ID(1), mark: 'done', applied: false }, { id: ID(2), mark: 'partly', applied: false }],
    });
    expect(unsaved).toEqual([
      { id: ID(1), mark: 'done', stillLeft: null, description: 'Check under the dishwasher and the kitchen sink' },
      { id: ID(2), mark: 'partly', stillLeft: 'the left side', description: 'Look at the gap under the garage door' },
    ]);
  });

  test('a saved Partly note, or a promise closed meanwhile, leaves nothing to settle', async () => {
    CallCommitments.listOpenCommitments.mockResolvedValue([]);
    const unsaved = await VisitPromises.unsavedVisitPromiseMarks(LIST_DB, {
      customerId: 'cust-1', marks, results: [{ id: ID(2), mark: 'partly', applied: true }],
    });
    expect(unsaved).toEqual([]);
  });

  test('a list that cannot be read counts every Done and Partly mark, so the failure surfaces', async () => {
    CallCommitments.listOpenCommitments.mockRejectedValue(new Error('db down'));
    const unsaved = await VisitPromises.unsavedVisitPromiseMarks(LIST_DB, { customerId: 'cust-1', marks, results: null });
    expect(unsaved.map((entry) => [entry.id, entry.mark, entry.description])).toEqual([[ID(1), 'done', null], [ID(2), 'partly', null]]);
  });

  test('one office bell per visit, following the notification rule; nothing when all were saved', async () => {
    const NotificationService = require('../services/notification-service');
    const conn = (table) => ({ where: () => ({ first: async () => (table === 'customers' ? { first_name: 'Pat', last_name: 'Doe' } : null) }) });
    const Episodes = require('../services/admin-alert-episodes');
    // Nothing left unsaved (a resumed completion saved them): the visit's
    // own bell, if one rang, is closed; none is raised.
    expect(await VisitPromises.alertUnsavedVisitPromiseMarks(conn, { customerId: 'cust-1', serviceId: 'svc-1', visitDate: '2026-10-01', unsaved: [] })).toBeNull();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(Episodes.closeAdminAlertKeys).toHaveBeenCalledWith(conn, ['visit-promise-marks:svc-1'], 'promise_marks_saved', expect.objectContaining({ resolution: expect.any(String) }));
    await VisitPromises.alertUnsavedVisitPromiseMarks(conn, {
      customerId: 'cust-1', serviceId: 'svc-1', visitDate: '2026-10-01',
      unsaved: [{ id: ID(1), mark: 'done', stillLeft: null, description: 'Check under the dishwasher' }],
    });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledWith(
      'alert',
      'Comms — update a promise the technician marked',
      "Marked at Pat Doe's October 1 visit, but the promise list does not show it.",
      expect.objectContaining({
        // The customer's own promise controls: call, text and email promises.
        link: '/admin/customers?customerId=cust-1&tab=comms',
        dedupeKey: 'visit-promise-marks:svc-1',
        bell: true,
        detail: expect.stringContaining('"Check under the dishwasher": marked Done, still open.'),
        metadata: expect.objectContaining({ subject: { type: 'visit', id: 'svc-1' }, severity: 'needs-you', promise_ids: [ID(1)] }),
      }),
    );
  });
});

describe('wiring source contracts', () => {
  const fs = require('fs');
  const path = require('path');
  const completionSource = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
  const routeSource = fs.readFileSync(path.join(__dirname, '../routes/admin-schedule.js'), 'utf8');

  test('completion applies the marks POST-COMMIT, fail-soft, before the response payload', () => {
    const call = completionSource.indexOf('VisitPromises.applyVisitPromiseMarks(db, {');
    expect(call).toBeGreaterThan(completionSource.indexOf('durableCompletionCommitted = true;'));
    // Right after the committed-truth re-derivation (a resumed backfill is
    // judged as committed), before any later step can return early or
    // deliver the report (Codex #5516).
    expect(call).toBeGreaterThan(completionSource.indexOf('isBackfillCompletion = frozenResume.isBackfillCompletion;'));
    expect(call).toBeLessThan(completionSource.indexOf('releaseCompletionAttemptForResume(completionAttempt, lookupErr)'));
    expect(call).toBeLessThan(completionSource.indexOf('Backfill tracker stamp (Codex P2, PR #2897 fix round 4)'));
    expect(completionSource.indexOf('const responsePayload = {', call)).toBeGreaterThan(call);
    const block = completionSource.slice(completionSource.lastIndexOf('if (!isBackfillCompletion', call), call + 1800);
    expect(block).toMatch(/visitOutcome !== 'customer_declined' && visitOutcome !== 'incomplete'/);
    expect(block).toMatch(/Array\.isArray\(promiseMarks\) && promiseMarks\.length/);
    expect(block).toMatch(/reportWriterRulesLive\(\)/);
    expect(block).toMatch(/effectiveCompletionProfile && VisitPromises\.promiseCheckInScope\(svc\.service_type, effectiveCompletionProfile\)/);
    // What did not reach the list is checked after the write (even when it
    // threw) and rings the office (Codex #5516).
    const unsaved = block.indexOf('VisitPromises.unsavedVisitPromiseMarks(db, {');
    expect(unsaved).toBeGreaterThan(block.indexOf('catch (applyErr)'));
    expect(block.indexOf('VisitPromises.alertUnsavedVisitPromiseMarks(db, {')).toBeGreaterThan(unsaved);
    const catchBody = block.slice(block.indexOf('catch (promiseErr)'));
    expect(catchBody).toMatch(/logger\.warn/);
    expect(catchBody).not.toMatch(/res\.status|throw/);
    // One call site: the completed exit only (an incomplete visit keeps its promises open).
    expect(completionSource.split('applyVisitPromiseMarks(').length - 1).toBe(1);
  });

  test('completion asks before sending when a marked promise changed (confirmable, pre-save)', () => {
    const check = completionSource.indexOf("code: 'promise_marks_changed'");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(completionSource.indexOf('durableCompletionCommitted = true;'));
    const block = completionSource.slice(completionSource.lastIndexOf('if (!promiseMarksConfirmed', check), check + 200);
    expect(block).toMatch(/visitOutcome !== 'customer_declined' && !isBackfillCompletion/);
    expect(block).toMatch(/staleVisitPromiseMarks\(db, \{ customerId: svc\.customer_id, marks: promiseMarks \}\)/);
    expect(block).toMatch(/hasCommittedCompletionAttempt/);
    expect(block).toMatch(/confirmable: true/);
    expect(completionSource).toMatch(/promiseMarksConfirmed = false, \/\/ tech confirmed sending/);
  });

  test('the generate route reads marks only with the writer rules on a grounded visit', () => {
    expect(routeSource).toMatch(/if \(writerRulesOn && groundingCustomerId && Array\.isArray\(promiseMarks\) && promiseMarks\.length\) \{/);
    // A validated mark is visit detail on its own.
    expect(routeSource).toMatch(/if \(!baseHasReportInput && !companionCustomerInput && !visitPromises\.length\) \{/);
    expect(routeSource).toMatch(/visitPromises,\n\s+\}\);/);
  });
});

