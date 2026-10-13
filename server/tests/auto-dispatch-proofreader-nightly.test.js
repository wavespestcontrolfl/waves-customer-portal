// Move proofreader, the nightly call (owner 2026-10-12): what each verdict
// does to a planned move, and the admin notice for a move the check is
// unsure about. The model's answer and the record are faked here; the judge
// and the record builder have their own suite (auto-dispatch-proofreader).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/auto-dispatch/audit', () => ({
  ...jest.requireActual('../services/auto-dispatch/audit'),
  ringsLeft: jest.fn(async () => 10),
  retireResolvedNotices: jest.fn(async () => {}),
  namedVisitAction: jest.fn(async (_id, templates) => templates[0]('Pat Sample')),
}));

const notifications = require('../services/notification-service');
const audit = require('../services/auto-dispatch/audit');
const nightly = require('../services/auto-dispatch/proofreader/nightly');
const { moveFacts } = require('../services/auto-dispatch/proofreader');

const SERVICE = {
  id: 's1', customer_id: 'c1', service_type: 'Quarterly Pest Control', scheduled_date: '2026-10-20', window_start: '09:00', window_end: '10:00', technician_id: 't1',
};
const BEST = { date: '2026-10-22', start_time: '13:00', end_time: '14:00', technician_id: 't2' };
const RECORD = {
  entries: [{ id: 'E1', channel: 'text', from: 'customer', at: '2026-09-01T10:00:00-04:00', text: 'Please never come on Thursdays. I work from home that day.' }],
  unread: [], serviceTypes: ['Quarterly Pest Control'], tooLong: false,
};

const conn = () => {
  const chain = { whereIn: () => chain, select: async () => [{ id: 't1', name: 'Alex Rivera' }, { id: 't2', name: 'Sam Lee' }] };
  return () => chain;
};
// A proofreader whose model answers `answer`.
const proofreaderOf = (answer, record = RECORD) => ({
  buildCustomerRecord: jest.fn(async () => record),
  moveFacts,
  proofreadMove: jest.fn(async () => ({ model: 'claude-opus-5-5', prompt_version: 'move-proofreader-v1', ...answer })),
});
const runOf = (overrides = {}) => ({ config: { proofreaderMaxCalls: 60 }, proofreader: nightly.newRunState(), ...overrides });
const check = (run, proofreader) => nightly.checkMove({ service: SERVICE, best: BEST, run }, { conn: conn(), proofreader });

beforeEach(() => {
  jest.clearAllMocks();
  audit.ringsLeft.mockResolvedValue(10);
  notifications.notifyAdmin.mockResolvedValue({ id: 'n1' });
});

describe('checkMove', () => {
  test('off for the run: nothing is asked and the caller gets null', async () => {
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    expect(await check(runOf({ proofreader: null }), proofreader)).toBeNull();
    expect(proofreader.buildCustomerRecord).not.toHaveBeenCalled();
  });

  test('the model reads the record as of now and the move with both slots and first names', async () => {
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    await check(runOf(), proofreader);
    expect(proofreader.buildCustomerRecord.mock.calls[0][1]).toMatchObject({ customerId: 'c1', serviceId: 's1' });
    const { move } = proofreader.proofreadMove.mock.calls[0][0];
    expect(move).toMatchObject({
      service: 'Quarterly Pest Control', change: 'different day',
      from: { date: '2026-10-20', weekday: 'Tuesday', technician: 'Alex' },
      to: { date: '2026-10-22', weekday: 'Thursday', technician: 'Sam' },
    });
  });

  describe('a grouped stop does not move while the check is on (owner 2026-10-12)', () => {
    const service = { ...SERVICE, visit_id: 'v1' };
    // The unit mover's own member read, by how many open members the stop has.
    const stopOf = (count) => (table) => {
      const chain = {
        where: () => chain, whereIn: () => chain, whereNotIn: () => chain,
        select: async () => {
          if (table === 'technicians') return [{ id: 't1', name: 'Alex Rivera' }, { id: 't2', name: 'Sam Lee' }];
          if (count instanceof Error) throw count;
          return Array.from({ length: count }, (_, i) => ({ id: `m${i}` }));
        },
      };
      return chain;
    };

    test('two or more open members: nobody is asked, the visit stays, no notice', async () => {
      const run = runOf();
      const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
      const got = await nightly.checkMove({ service, best: BEST, run }, { conn: stopOf(2), proofreader });
      expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_GROUPED_STOP', audit: { verdict: 'unknown', why: 'grouped_stop' } });
      expect(proofreader.buildCustomerRecord).not.toHaveBeenCalled();
      expect(run.proofreader).toMatchObject({ calls: 0, grouped: 1, unsure: 0 });
      expect(run.proofreader.notices.size).toBe(0);
    });

    test('a visit whose stop holds it alone is asked like any other', async () => {
      const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
      expect(await nightly.checkMove({ service, best: BEST, run: runOf() }, { conn: stopOf(1), proofreader })).toMatchObject({ allowed: true });
    });

    test('a stop that cannot be read is never an allow, and nobody is asked', async () => {
      const run = runOf();
      const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
      const got = await nightly.checkMove({ service, best: BEST, run }, { conn: stopOf(new Error('db down')), proofreader });
      expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { why: 'check_failed' } });
      expect(proofreader.buildCustomerRecord).not.toHaveBeenCalled();
      expect(run.proofreader.calls).toBe(0);
    });
  });

  test('allow: the move may go ahead, and the audit keeps ids and codes only', async () => {
    const run = runOf();
    const got = await check(run, proofreaderOf({ verdict: 'allow', why: 'nothing_breaks', reason: 'Nothing limits the day.' }));
    expect(got).toEqual({
      allowed: true, audit: { verdict: 'allow', why: 'nothing_breaks', entry_id: null, model: 'claude-opus-5-5', prompt_version: 'move-proofreader-v1' },
    });
    expect(run.proofreader).toMatchObject({ calls: 1, allowed: 1, held: 0, unsure: 0 });
    expect(run.proofreader.notices.size).toBe(0);
  });

  test('an allow stands only when the record read again after the answer is the one the model saw', async () => {
    const run = runOf();
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    const newer = { ...RECORD, entries: [...RECORD.entries, { id: 'E2', channel: 'text', from: 'customer', at: '2026-10-12T04:11:00-04:00', text: 'Not Thursday please.' }] };
    proofreader.buildCustomerRecord.mockResolvedValueOnce(RECORD).mockResolvedValueOnce(newer);
    const got = await check(run, proofreader);
    expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { verdict: 'unknown', why: 'record_changed' } });
    // Nobody has judged the new words yet: the next run asks, and no notice is raised now.
    expect(run.proofreader.notices.size).toBe(0);
    // The same record on the second read: the allow stands (two reads, one model call).
    const same = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    expect(await check(runOf(), same)).toMatchObject({ allowed: true });
    expect(same.buildCustomerRecord).toHaveBeenCalledTimes(2);
    expect(same.proofreadMove).toHaveBeenCalledTimes(1);
  });

  test('a service changed at the stop while the model read: the allow does not stand', async () => {
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    proofreader.buildCustomerRecord.mockResolvedValueOnce(RECORD).mockResolvedValueOnce({ ...RECORD, serviceTypes: ['Lawn Care'] });
    expect(await check(runOf(), proofreader)).toMatchObject({ allowed: false, audit: { why: 'record_changed' } });
  });

  test('an unsure move on a new placement of the same visit and date is a new notice', async () => {
    const run = runOf();
    const proofreader = proofreaderOf({ verdict: 'unknown', why: 'model_unsure' });
    await check(run, proofreader);
    await nightly.checkMove({ service: { ...SERVICE, window_start: '13:00' }, best: BEST, run }, { conn: conn(), proofreader });
    await nightly.checkMove({ service: { ...SERVICE, window_start: '13:00' }, best: BEST, run }, { conn: conn(), proofreader });
    expect([...run.proofreader.notices.keys()]).toEqual(['auto-dispatch-proofreader:s1:2026-10-20:09:00:t1', 'auto-dispatch-proofreader:s1:2026-10-20:13:00:t1']);
  });

  test('hold: the visit stays, no notice, and the quote never reaches the audit', async () => {
    const run = runOf();
    const got = await check(run, proofreaderOf({ verdict: 'hold', why: 'quoted_statement', entry_id: 'E1', quote: 'never come on Thursdays', reason: 'Thursday breaks it.' }));
    expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_HOLD', audit: { verdict: 'hold', entry_id: 'E1' } });
    expect(JSON.stringify(got)).not.toMatch(/Thursdays/);
    expect(run.proofreader.held).toBe(1);
    expect(run.proofreader.notices.size).toBe(0);
  });

  test.each(['model_unsure', 'hold_without_quote', 'record_incomplete', 'record_too_long'])('unknown (%s): the visit stays and a notice is collected', async (why) => {
    const run = runOf();
    const got = await check(run, proofreaderOf({ verdict: 'unknown', why }));
    expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { verdict: 'unknown', why } });
    expect([...run.proofreader.notices.keys()]).toEqual(['auto-dispatch-proofreader:s1:2026-10-20:09:00:t1']);
  });

  test.each(['model_failed', 'bad_answer'])('unknown (%s): the visit stays and no notice is collected (the next run asks again)', async (why) => {
    const run = runOf();
    expect(await check(run, proofreaderOf({ verdict: 'unknown', why }))).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE' });
    expect(run.proofreader.notices.size).toBe(0);
  });

  test('a record that cannot be built is never an allow', async () => {
    const run = runOf();
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    proofreader.buildCustomerRecord.mockRejectedValue(new Error('db down'));
    expect(await check(run, proofreader)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { why: 'check_failed' } });
    expect(proofreader.proofreadMove).not.toHaveBeenCalled();
    expect(run.proofreader.notices.size).toBe(0);
    // No model was asked: the call limit is not spent.
    expect(run.proofreader.calls).toBe(0);
  });

  test('a record too long to send spends no call either', async () => {
    const run = runOf();
    await check(run, proofreaderOf({ verdict: 'unknown', why: 'record_too_long' }, { ...RECORD, tooLong: true }));
    expect(run.proofreader).toMatchObject({ calls: 0, unsure: 1 });
  });

  test('no call starts after the run deadline (the 04:20 route job needs the lock)', async () => {
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    const late = runOf({ proofreader: nightly.newRunState({ startedAt: Date.now() - 301000, deadlineSeconds: 300 }) });
    expect(await check(late, proofreader)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_NOT_ASKED', audit: { why: 'deadline' }, broke: false });
    expect(proofreader.buildCustomerRecord).not.toHaveBeenCalled();
    const inTime = runOf({ proofreader: nightly.newRunState({ startedAt: Date.now() - 1000, deadlineSeconds: 300 }) });
    expect(await check(inTime, proofreader)).toMatchObject({ allowed: true });
  });

  test.each(['model_failed', 'bad_answer'])('a check that broke (%s) is marked so the run cannot end green; an unsure answer is not', async (why) => {
    const run = runOf();
    expect(await check(run, proofreaderOf({ verdict: 'unknown', why }))).toMatchObject({ allowed: false, broke: true });
    expect(await check(run, proofreaderOf({ verdict: 'unknown', why: 'model_unsure' }))).toMatchObject({ broke: false });
    expect(run.proofreader.broke).toBe(1);
  });

  test('a record with a source the database could not read is a broken check: no notice, the run is marked', async () => {
    const run = runOf();
    const partial = { ...RECORD, unread: [{ channel: 'call', reason: 'read_failed' }] };
    const got = await check(run, proofreaderOf({ verdict: 'unknown', why: 'record_incomplete' }, partial));
    expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { why: 'check_failed' }, broke: true });
    expect(run.proofreader.notices.size).toBe(0);
    // A record that is incomplete for a reason about the customer (a call with no transcript) is not.
    const noTranscript = { ...RECORD, unread: [{ channel: 'call', reason: 'no_transcript' }] };
    expect(await check(run, proofreaderOf({ verdict: 'unknown', why: 'record_incomplete' }, noTranscript))).toMatchObject({ broke: false });
    expect(run.proofreader.notices.size).toBe(1);
  });

  test('past the call limit a move is held without a call', async () => {
    const run = runOf({ config: { proofreaderMaxCalls: 1 } });
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    expect(await check(run, proofreader)).toMatchObject({ allowed: true });
    expect(await check(run, proofreader)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_NOT_ASKED' });
    expect(proofreader.proofreadMove).toHaveBeenCalledTimes(1);
    expect(run.proofreader).toMatchObject({ calls: 1, notAsked: 1 });
  });
});

describe('the write of a checked move', () => {
  const fallback = { alternateCandidates: ['a', 'b'], rescore: () => {} };
  test('a checked move lands on the approved slot only: no alternates, no re-evaluation', () => {
    expect(nightly.writeOptions({ allowed: true }, fallback)).toEqual({ alternateCandidates: [], proofread: true });
  });

  test('a visit that joined a stop of two or more after the check is refused at the write', () => {
    const refuse = (id, why) => new Error(`${id} ${why}`);
    expect(() => nightly.assertNotGrouped([{ id: 's1' }, { id: 's2' }], true, refuse, 's1')).toThrow('s1 joined a grouped stop after the move was checked');
    expect(() => nightly.assertNotGrouped([{ id: 's1' }], true, refuse, 's1')).not.toThrow();
    // A move that was not proofread keeps today's grouped behavior.
    expect(() => nightly.assertNotGrouped([{ id: 's1' }, { id: 's2' }], undefined, refuse, 's1')).not.toThrow();
  });

  test('check off: the fallback is unchanged', () => {
    expect(nightly.writeOptions(null, fallback)).toBe(fallback);
  });
  test('a taken approved slot is not a failure; a partial grouped move still is', () => {
    const taken = Object.assign(new Error('taken'), { code: 'SLOT_TAKEN' });
    expect(nightly.approvedSlotTaken({ allowed: true }, taken)).toBe(true);
    expect(nightly.approvedSlotTaken(null, taken)).toBe(false);
    expect(nightly.approvedSlotTaken({ allowed: true }, Object.assign(new Error('x'), { code: 'SLOT_TAKEN', movedCount: 1 }))).toBe(false);
    expect(nightly.approvedSlotTaken({ allowed: true }, Object.assign(new Error('x'), { code: 'SLOT_TAKEN', failedMembers: ['s2'] }))).toBe(false);
    expect(nightly.approvedSlotTaken({ allowed: true }, Object.assign(new Error('x'), { code: 'STALE_PLACEMENT' }))).toBe(false);
  });
});


describe('raiseNotices', () => {
  // The run-end re-read of each visit: by default it is still as the check read it.
  let visitRow;
  beforeEach(() => { visitRow = (id) => ({ status: 'confirmed', scheduled_date: null, window_start: '09:00', technician_id: 't1', id }); });
  const visits = () => () => {
    let wanted = null;
    const chain = {
      where: (cond) => { wanted = cond.id; return chain; },
      first: async () => {
        const row = visitRow(wanted);
        if (row instanceof Error) throw row;
        return row && row.scheduled_date === null ? { ...row, scheduled_date: DATES[wanted] || '2026-10-20' } : row;
      },
    };
    return chain;
  };
  const DATES = { late: '2026-11-20', soon: '2026-10-18', mid: '2026-10-30' };

  const unsure = async (answer, service = SERVICE) => {
    const run = runOf();
    await nightly.checkMove({ service, best: BEST, run }, { conn: conn(), proofreader: proofreaderOf({ verdict: 'unknown', ...answer }) });
    return run.proofreader;
  };

  test('an unsure move with a quote: the notice names the customer, both dates and the words', async () => {
    const state = await unsure({ why: 'model_unsure', entry_id: 'E1', quote: 'never come on Thursdays', reason: 'The note may be about another service.' });
    expect(await nightly.raiseNotices(state, { conn: visits() })).toBe(1);
    const [category, title, body, opts] = notifications.notifyAdmin.mock.calls[0];
    expect(category).toBe('schedule_conflict');
    expect(title).toBe("Schedule — check a held move of Pat Sample's visit");
    expect(body).toBe('Move from Oct 20 to Oct 22 held; the record says “never come on Thursdays”');
    expect(opts).toMatchObject({
      bell: true, dedupeKey: 'auto-dispatch-proofreader:s1:2026-10-20:09:00:t1', link: '/admin/dispatch?tab=schedule&date=2026-10-20&appointment=s1',
      metadata: { scheduledServiceId: 's1', customerId: 'c1', scheduledDate: '2026-10-20', windowStart: '09:00', technicianId: 't1', kind: 'model_unsure', proposedDate: '2026-10-22' },
    });
    // Written once: a later run that is still unsure must not reopen a notice a person closed.
    expect(opts.refreshOnDedupe).toBeUndefined();
    expect(opts.detail).toContain('from Tuesday Oct 20, 09:00-11:00 to Thursday Oct 22, 13:00-15:00.');
    expect(opts.detail).toContain('The check said: The note may be about another service.');
    expect(opts.detail).toContain('(text, customer, 2026-09-01T10:00:00-04:00): “never come on Thursdays”');
    expect(opts.detail).toContain('mark this done and the visit stays');
  });

  test('a record that could not be read in full says so, in one sentence', async () => {
    const state = await unsure({ why: 'record_incomplete' });
    await nightly.raiseNotices(state, { conn: visits() });
    expect(notifications.notifyAdmin.mock.calls[0][2]).toBe('Move from Oct 20 to Oct 22 held: part of the customer record could not be read.');
  });

  test('a same-day new time reads as a new time, not a move', async () => {
    const run = runOf();
    await nightly.checkMove({ service: SERVICE, best: { ...BEST, date: '2026-10-20' }, run }, { conn: conn(), proofreader: proofreaderOf({ verdict: 'unknown', why: 'model_unsure' }) });
    await nightly.raiseNotices(run.proofreader, { conn: visits() });
    expect(notifications.notifyAdmin.mock.calls[0][2]).toBe('New time on Oct 20 held: a note may limit when this visit can happen.');
  });

  test('the shared ring allowance: soonest date first, the rest wait', async () => {
    const run = runOf();
    const proofreader = proofreaderOf({ verdict: 'unknown', why: 'model_unsure' });
    for (const [id, date] of [['late', '2026-11-20'], ['soon', '2026-10-18'], ['mid', '2026-10-30']]) {
      await nightly.checkMove({ service: { ...SERVICE, id, scheduled_date: date }, best: BEST, run }, { conn: conn(), proofreader });
    }
    audit.ringsLeft.mockResolvedValue(2);
    expect(await nightly.raiseNotices(run.proofreader, { conn: visits() })).toBe(2);
    expect(notifications.notifyAdmin.mock.calls.map((call) => call[3].metadata.scheduledServiceId)).toEqual(['soon', 'mid']);
  });

  test.each([
    ['cancelled', { status: 'cancelled', scheduled_date: '2026-10-20', window_start: '09:00', technician_id: 't1' }],
    ['moved to another day', { status: 'confirmed', scheduled_date: '2026-10-21', window_start: '09:00', technician_id: 't1' }],
    ['given a new time that day', { status: 'confirmed', scheduled_date: '2026-10-20', window_start: '13:00', technician_id: 't1' }],
    ['given another technician', { status: 'confirmed', scheduled_date: '2026-10-20', window_start: '09:00', technician_id: 't9' }],
    ['gone', null],
    ['unreadable', new Error('db down')],
  ])('a visit %s since the check raises nothing and spends no slot', async (_name, row) => {
    const state = await unsure({ why: 'model_unsure' });
    visitRow = () => row;
    expect(await nightly.raiseNotices(state, { conn: visits() })).toBe(0);
    expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a long answer never pushes the quote or the closing instruction out of the detail', async () => {
    const state = await unsure({ why: 'model_unsure', entry_id: 'E1', quote: `never on Thursdays ${'and more words '.repeat(200)}`, reason: 'word '.repeat(400) });
    await nightly.raiseNotices(state, { conn: visits() });
    const { detail } = notifications.notifyAdmin.mock.calls[0][3];
    expect(detail.length).toBeLessThan(2000);
    expect(detail).toContain('“never on Thursdays and more words');
    expect(detail.endsWith('mark this done and the visit stays.')).toBe(true);
  });


  test('the check turned off: the next run closes every open notice', async () => {
    await nightly.closeNotices(new Date(), { enabled: false });
    const q = { whereRaw: jest.fn(() => q), whereIn: jest.fn(() => q) };
    const [spec] = audit.retireResolvedNotices.mock.calls[0];
    spec.stillOpen(q);
    expect(q.whereRaw).toHaveBeenCalledWith('1 = 0');
    expect(spec.resolution).toBe('The move check is turned off');
  });

  test('the close keeps a notice open only while the visit is on the placement the check read', async () => {
    await nightly.closeNotices(new Date());
    const q = { whereRaw: jest.fn(() => q), whereIn: jest.fn(() => q) };
    audit.retireResolvedNotices.mock.calls[0][0].stillOpen(q);
    const sql = q.whereRaw.mock.calls[0][0];
    expect(sql).toContain("metadata->>'scheduledDate'");
    expect(sql).toContain("s.window_start::text IS NOT DISTINCT FROM notifications.metadata->>'windowStart'");
    expect(sql).toContain("s.technician_id::text IS NOT DISTINCT FROM notifications.metadata->>'technicianId'");
    expect(q.whereIn).toHaveBeenCalledWith('s.status', ['pending', 'confirmed']);
  });

  test('a notice that already exists is left as it is and spends no slot', async () => {
    const state = await unsure({ why: 'model_unsure' });
    notifications.notifyAdmin.mockResolvedValue({ id: 'n1', deduped: true });
    expect(await nightly.raiseNotices(state, { conn: visits() })).toBe(0);
  });

  test('every run closes the notices whose visit moved or is no longer open, the check off included', async () => {
    expect(await nightly.raiseNotices(null)).toBe(0);
    await nightly.closeNotices(new Date('2026-10-12T08:10:00Z'));
    expect(audit.retireResolvedNotices).toHaveBeenCalledTimes(1);
    const [spec] = audit.retireResolvedNotices.mock.calls[0];
    expect(spec).toMatchObject({ keyPattern: 'auto-dispatch-proofreader:%', resolvedTitle: 'Move check alert resolved' });
    expect(notifications.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a failed write is logged and never fails the run', async () => {
    const state = await unsure({ why: 'model_unsure' });
    notifications.notifyAdmin.mockRejectedValue(new Error('store down'));
    audit.retireResolvedNotices.mockRejectedValueOnce(new Error('close down'));
    await expect(nightly.closeNotices(new Date())).resolves.toBeUndefined();
    expect(await nightly.raiseNotices(state, { conn: visits() })).toBe(0);
  });
});
