// Move proofreader, the nightly call (owner 2026-10-12): what each verdict
// does to a planned move. An unsure move asks nobody (owner 2026-10-29); a
// run only closes the notices left open from before. The model's answer and
// the record are faked here; the judge and the record builder have their own
// suite (auto-dispatch-proofreader).
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/notification-service', () => ({
  safeErrorSummary: jest.requireActual('../services/notification-service').safeErrorSummary,
  // The store's own "a person closed it" rule, as the hold read uses it.
  _private: {
    isPersonDoneBy: jest.requireActual('../services/notification-service')._private.isPersonDoneBy,
    doneColumns: () => ({ done_at: 'now', done_by: 'auto-dispatch' }),
  },
}));
jest.mock('../services/auto-dispatch/audit', () => ({
  ...jest.requireActual('../services/auto-dispatch/audit'),
  retireResolvedNotices: jest.fn(async () => {}),
}));

const db = require('../models/db');
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

// Technician names, and the notification store as the "did a person mark the
// notice done" read sees it (`doneNotice`: the row it finds, or an Error).
const PERSON_DONE = { id: 'n9', title: 'Schedule — check a held move', done_at: '2026-10-12T15:00:00Z', done_by: '7f1c9a52-3b1e-4c1d-9a55-0d6f1f2a3b4c' };
let doneNotice = null;
const conn = () => (table) => {
  const chain = {
    where: () => chain, whereIn: () => chain, whereRaw: () => chain, orderBy: () => chain,
    select: async () => [{ id: 't1', name: 'Alex Rivera' }, { id: 't2', name: 'Sam Lee' }],
    first: async () => {
      if (table !== 'notifications') return null;
      if (doneNotice instanceof Error) throw doneNotice;
      return doneNotice;
    },
  };
  return chain;
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
  doneNotice = null;
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
        where: () => chain, whereIn: () => chain, whereNotIn: () => chain, whereRaw: () => chain, orderBy: () => chain,
        first: async () => null,
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
      allowed: true, recordPrint: expect.any(String), audit: { verdict: 'allow', why: 'nothing_breaks', entry_id: null, model: 'claude-opus-5-5', prompt_version: 'move-proofreader-v1' },
    });
    expect(run.proofreader).toMatchObject({ calls: 1, allowed: 1, held: 0, unsure: 0 });
  });

  test('an allow stands only when the record read again after the answer is the one the model saw', async () => {
    const run = runOf();
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    const newer = { ...RECORD, entries: [...RECORD.entries, { id: 'E2', channel: 'text', from: 'customer', at: '2026-10-12T04:11:00-04:00', text: 'Not Thursday please.' }] };
    proofreader.buildCustomerRecord.mockResolvedValueOnce(RECORD).mockResolvedValueOnce(newer);
    const got = await check(run, proofreader);
    expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { verdict: 'unknown', why: 'record_changed' } });
    // Nobody has judged the new words yet: the next run asks.
    // The same record on the second read: the allow stands (two reads, one model call).
    const same = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    expect(await check(runOf(), same)).toMatchObject({ allowed: true });
    expect(same.buildCustomerRecord).toHaveBeenCalledTimes(2);
    expect(same.proofreadMove).toHaveBeenCalledTimes(1);
  });

  test('the second record read fails: a broken check the run reports, not "the record changed"', async () => {
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    proofreader.buildCustomerRecord.mockResolvedValueOnce(RECORD).mockResolvedValueOnce({ ...RECORD, unread: [{ channel: 'text', reason: 'read_failed' }] });
    expect(await check(runOf(), proofreader)).toMatchObject({ allowed: false, audit: { why: 'check_failed' }, broke: true });
  });

  test('a source already unread that fails on the second read is a broken check, not an unchanged record', async () => {
    const run = runOf();
    const first = { ...RECORD, unread: [{ channel: 'call', reason: 'no_transcript' }] };
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    proofreader.buildCustomerRecord.mockResolvedValueOnce(first).mockResolvedValueOnce({ ...RECORD, unread: [{ channel: 'call', reason: 'read_failed' }] });
    expect(await check(run, proofreader)).toMatchObject({ allowed: false, audit: { why: 'check_failed' }, broke: true });
  });

  test('a service changed at the stop while the model read: the allow does not stand', async () => {
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    proofreader.buildCustomerRecord.mockResolvedValueOnce(RECORD).mockResolvedValueOnce({ ...RECORD, serviceTypes: ['Lawn Care'] });
    expect(await check(runOf(), proofreader)).toMatchObject({ allowed: false, audit: { why: 'record_changed' } });
  });

  test('a notice a person marked done holds the visit: nobody is asked, the visit stays', async () => {
    const run = runOf();
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    doneNotice = PERSON_DONE;
    expect(await check(run, proofreader)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_PERSON_HELD', audit: { why: 'person_held' }, broke: false });
    expect(proofreader.buildCustomerRecord).not.toHaveBeenCalled();
    expect(run.proofreader).toMatchObject({ calls: 0, personHeld: 1 });
    // Only a person's done holds: an open notice, a system close, or a system-resolved row decides nothing.
    for (const row of [{ ...PERSON_DONE, done_at: null, done_by: null }, { ...PERSON_DONE, done_by: 'auto-dispatch' }, { ...PERSON_DONE, title: nightly.RESOLVED_TITLE }]) {
      doneNotice = row;
      expect(await check(runOf(), proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' }))).toMatchObject({ allowed: true });
    }
    // Done lands while the model reads: the allow does not move the visit.
    doneNotice = null;
    const slow = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    slow.proofreadMove.mockImplementation(async () => { doneNotice = PERSON_DONE; return { verdict: 'allow', why: 'nothing_breaks' }; });
    expect(await check(run, slow)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_PERSON_HELD' });
    // The store fails on the read after an allow: a broken check the run reports, not a made-up hold.
    doneNotice = null;
    const failing = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    failing.proofreadMove.mockImplementation(async () => { doneNotice = new Error('db down'); return { verdict: 'allow', why: 'nothing_breaks' }; });
    expect(await check(run, failing)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { why: 'check_failed' }, broke: true });
    // An unreadable store is never an allow, and the run reports it.
    doneNotice = new Error('db down');
    expect(await check(run, proofreader)).toMatchObject({ allowed: false, audit: { why: 'check_failed' }, broke: true });
  });

  test('an unsure answer is not read again: the visit stays whatever landed while the model read', async () => {
    const run = runOf();
    const proofreader = proofreaderOf({ verdict: 'unknown', why: 'model_unsure', entry_id: 'E1', quote: 'never come on Thursdays' });
    const newer = { ...RECORD, entries: [...RECORD.entries, { id: 'E2', channel: 'text', from: 'customer', at: '2026-10-12T04:11:00-04:00', text: 'Any day is fine now.' }] };
    proofreader.buildCustomerRecord.mockResolvedValueOnce(RECORD).mockResolvedValueOnce(newer);
    expect(await check(run, proofreader)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { why: 'model_unsure' }, broke: false });
    expect(proofreader.buildCustomerRecord).toHaveBeenCalledTimes(1);
  });

  test('hold: the visit stays, and the quote never reaches the audit', async () => {
    const run = runOf();
    const got = await check(run, proofreaderOf({ verdict: 'hold', why: 'quoted_statement', entry_id: 'E1', quote: 'never come on Thursdays', reason: 'Thursday breaks it.' }));
    expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_HOLD', audit: { verdict: 'hold', entry_id: 'E1' } });
    expect(JSON.stringify(got)).not.toMatch(/Thursdays/);
    expect(run.proofreader.held).toBe(1);
  });

  test.each(['model_unsure', 'hold_without_quote', 'record_incomplete', 'record_too_long', 'model_failed', 'bad_answer'])('unknown (%s): the visit stays and the next run asks again', async (why) => {
    const run = runOf();
    const got = await check(run, proofreaderOf({ verdict: 'unknown', why }));
    expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { verdict: 'unknown', why } });
    expect(run.proofreader.unsure).toBe(1);
  });

  test('a failed read logs the error\'s code, never its message (a query error can carry a customer\'s email)', async () => {
    const logger = require('../services/logger');
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    proofreader.buildCustomerRecord.mockRejectedValue(Object.assign(new Error('select * from emails where to = pat@example.test - timeout'), { code: '57014' }));
    await check(runOf(), proofreader);
    const logged = logger.warn.mock.calls.map((call) => call[0]).join(' ');
    expect(logged).toContain('57014');
    expect(logged).not.toContain('pat@example.test');
  });

  test('a record that cannot be built is never an allow', async () => {
    const run = runOf();
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    proofreader.buildCustomerRecord.mockRejectedValue(new Error('db down'));
    expect(await check(run, proofreader)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { why: 'check_failed' } });
    expect(proofreader.proofreadMove).not.toHaveBeenCalled();
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
    // Counted for the check-down notice (a night the deadline stopped every check rings it).
    expect(late.proofreader).toMatchObject({ notAsked: 1, timedOut: 1, broke: 0 });
    const inTime = runOf({ proofreader: nightly.newRunState({ startedAt: Date.now() - 1000, deadlineSeconds: 300 }) });
    expect(await check(inTime, proofreader)).toMatchObject({ allowed: true });
  });

  test('the deadline is asked again after the record reads, right before the call', async () => {
    const run = runOf({ proofreader: nightly.newRunState({ startedAt: Date.now(), deadlineSeconds: 300 }) });
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    // The record read is slow: the deadline passes while it runs.
    proofreader.buildCustomerRecord.mockImplementation(async () => { run.proofreader.deadlineAt = Date.now() - 1; return RECORD; });
    expect(await check(run, proofreader)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_NOT_ASKED', audit: { why: 'deadline' }, broke: false });
    expect(proofreader.proofreadMove).not.toHaveBeenCalled();
    expect(run.proofreader).toMatchObject({ calls: 0, notAsked: 1, timedOut: 1, unsure: 0 });
  });

  test.each(['model_failed', 'bad_answer'])('a check that broke (%s) is marked so the run cannot end green; an unsure answer is not', async (why) => {
    const run = runOf();
    expect(await check(run, proofreaderOf({ verdict: 'unknown', why }))).toMatchObject({ allowed: false, broke: true });
    expect(await check(run, proofreaderOf({ verdict: 'unknown', why: 'model_unsure' }))).toMatchObject({ broke: false });
    expect(run.proofreader.broke).toBe(1);
  });

  test('the run keeps the first cause of a broken check and counts usable answers, for the move-check-down notice', async () => {
    const run = runOf();
    await check(run, proofreaderOf({ verdict: 'unknown', why: 'model_failed', reason: 'anthropic_400' }));
    await check(run, proofreaderOf({ verdict: 'unknown', why: 'model_failed', reason: 'anthropic_timeout' }));
    expect(run.proofreader).toMatchObject({ broke: 2, brokeCause: 'anthropic_400', answered: 0 });
    await check(run, proofreaderOf({ verdict: 'unknown', why: 'model_unsure' }));
    await check(run, proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' }));
    expect(run.proofreader).toMatchObject({ broke: 2, answered: 2 });
  });

  test('an allow whose follow-up read fails is no usable answer: the check-down notice must still see the night as broken (Codex #6465 r1)', async () => {
    const run = runOf();
    const failing = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    failing.proofreadMove.mockImplementation(async () => { doneNotice = new Error('db down'); return { verdict: 'allow', why: 'nothing_breaks' }; });
    await check(run, failing);
    expect(run.proofreader).toMatchObject({ broke: 1, brokeCause: 'check_failed', answered: 0 });
    // A person's done read after an allow: the model did answer.
    doneNotice = null;
    const held = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    held.proofreadMove.mockImplementation(async () => { doneNotice = PERSON_DONE; return { verdict: 'allow', why: 'nothing_breaks' }; });
    await check(run, held);
    expect(run.proofreader).toMatchObject({ personHeld: 1, answered: 1 });
  });

  test('a broken read names check_failed; a record too long or the deadline is not an answer', async () => {
    const run = runOf();
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    proofreader.buildCustomerRecord.mockRejectedValue(new Error('db down'));
    await check(run, proofreader);
    expect(run.proofreader).toMatchObject({ broke: 1, brokeCause: 'check_failed', answered: 0 });
    await check(run, proofreaderOf({ verdict: 'unknown', why: 'record_too_long' }, { ...RECORD, tooLong: true }));
    expect(run.proofreader.answered).toBe(0);
    const late = runOf({ proofreader: nightly.newRunState({ startedAt: Date.now() - 301000, deadlineSeconds: 300 }) });
    await check(late, proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' }));
    expect(late.proofreader.answered).toBe(0);
  });

  test('a record with a source the database could not read is a broken check: the run is marked', async () => {
    const run = runOf();
    const partial = { ...RECORD, unread: [{ channel: 'call', reason: 'read_failed' }] };
    const broken = proofreaderOf({ verdict: 'unknown', why: 'record_incomplete' }, partial);
    const got = await check(run, broken);
    expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', audit: { why: 'check_failed' }, broke: true });
    // No model is asked for an answer that could not be used, and no call is spent.
    expect(broken.proofreadMove).not.toHaveBeenCalled();
    expect(run.proofreader.calls).toBe(0);
    // A record that is incomplete for a reason about the customer (a call with no transcript) is not.
    const noTranscript = { ...RECORD, unread: [{ channel: 'call', reason: 'no_transcript' }] };
    expect(await check(run, proofreaderOf({ verdict: 'unknown', why: 'record_incomplete' }, noTranscript))).toMatchObject({ broke: false });
  });

  describe('which part of an incomplete record could not be read (owner 2026-11-01)', () => {
    const SECRET = 'Pat said the gate code is 4417 at 12 Palm Way';
    const unreadRecord = (unread) => ({ ...RECORD, unread });

    test('record_incomplete keeps channel and reason codes only, deduplicated', async () => {
      const unread = [
        { channel: 'call', at: '2026-10-01T09:00:00-04:00', reason: 'not_transcribed' },
        { channel: 'call', at: '2026-10-02T09:00:00-04:00', reason: 'not_transcribed' },
        { channel: 'text', reason: 'revised_later', text: SECRET, phone: '+19415550100' },
        { channel: 'note', at: '2026-10-03T09:00:00-04:00', reason: 'time_masked' },
      ];
      const run = runOf();
      const got = await check(run, proofreaderOf({ verdict: 'unknown', why: 'record_incomplete' }, unreadRecord(unread)));
      expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE', broke: false });
      expect(got.audit).toEqual({
        verdict: 'unknown', why: 'record_incomplete', entry_id: null, model: 'claude-opus-5-5', prompt_version: 'move-proofreader-v1',
        unread: [
          { channel: 'call', reason: 'not_transcribed' }, { channel: 'text', reason: 'revised_later' }, { channel: 'note', reason: 'time_masked' },
        ],
      });
      expect(JSON.stringify(got)).not.toMatch(/4417|Palm Way|9415550100|T09:00/);
      expect(run.proofreader.unsure).toBe(1);
    });

    test('at most ten entries are kept', async () => {
      const unread = Array.from({ length: 14 }, (_, i) => ({ channel: `source_${i}`, reason: 'revised_later' }));
      const got = await check(runOf(), proofreaderOf({ verdict: 'unknown', why: 'record_incomplete' }, unreadRecord(unread)));
      expect(got.audit.unread).toHaveLength(10);
      expect(got.audit.unread[9]).toEqual({ channel: 'source_9', reason: 'revised_later' });
    });

    test('a channel or reason that is not a plain code is replaced, never stored', () => {
      const { unreadSummary } = nightly._internals;
      expect(unreadSummary({ unread: [{ channel: SECRET, reason: 'x y' }, { channel: 'call' }, null] }))
        .toEqual([{ channel: 'unknown', reason: 'unknown' }, { channel: 'call', reason: 'unknown' }]);
      expect(unreadSummary(null)).toEqual([]);
    });

    test('a source the database could not read is also named (check_failed)', async () => {
      const got = await check(runOf(), proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' }, unreadRecord([{ channel: 'email', reason: 'read_failed' }])));
      expect(got).toMatchObject({ allowed: false, broke: true, audit: { why: 'check_failed', unread: [{ channel: 'email', reason: 'read_failed' }] } });
    });

    test('a hold on an incomplete record also names the unread part; the verdict is unchanged', async () => {
      const got = await check(runOf(), proofreaderOf(
        { verdict: 'hold', why: 'quoted_statement', entry_id: 'E1', quote: 'never come on Thursdays' },
        unreadRecord([{ channel: 'call', reason: 'not_transcribed' }]),
      ));
      expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_HOLD', audit: { verdict: 'hold', unread: [{ channel: 'call', reason: 'not_transcribed' }] } });
    });

    test('a complete record stores no unread key, and an unknown answer still leaves the visit in place', async () => {
      const got = await check(runOf(), proofreaderOf({ verdict: 'unknown', why: 'record_incomplete' }));
      expect(got).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_UNSURE' });
      expect(got.audit).not.toHaveProperty('unread');
    });
  });

  test('past the call limit a move is held without a call', async () => {
    const run = runOf({ config: { proofreaderMaxCalls: 1 } });
    const proofreader = proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' });
    expect(await check(run, proofreader)).toMatchObject({ allowed: true });
    expect(await check(run, proofreader)).toMatchObject({ allowed: false, reason_code: 'PROOFREADER_NOT_ASKED' });
    expect(proofreader.proofreadMove).toHaveBeenCalledTimes(1);
    // The call cap is a spent allowance, not a stopped clock: not timedOut.
    expect(run.proofreader).toMatchObject({ calls: 1, notAsked: 1, timedOut: 0 });
  });
});

describe('the write of a checked move', () => {
  const fallback = { alternateCandidates: ['a', 'b'], rescore: () => {} };
  test('a checked move lands on the approved slot only: no alternates, no re-evaluation', () => {
    expect(nightly.writeOptions({ allowed: true, recordPrint: 'p1' }, fallback)).toEqual({ alternateCandidates: [], proofread: true, approvedRecordPrint: 'p1' });
  });

  test('a visit that joined a stop of two or more after the check is refused at the write', () => {
    const refuse = (id, why) => new Error(`${id} ${why}`);
    expect(() => nightly.assertNotGrouped([{ id: 's1' }, { id: 's2' }], true, refuse, 's1')).toThrow('s1 joined a grouped stop after the move was checked');
    expect(() => nightly.assertNotGrouped([{ id: 's1' }], true, refuse, 's1')).not.toThrow();
    // A move that was not proofread keeps today's grouped behavior.
    expect(() => nightly.assertNotGrouped([{ id: 's1' }, { id: 's2' }], undefined, refuse, 's1')).not.toThrow();
  });

  describe('the move transaction asks once more that the approval still stands', () => {
    const refuse = (id, why) => new Error(`${id} ${why}`);
    const scored = () => require('../services/auto-dispatch/preferences').normalizePreferences(undefined, SERVICE.service_type);
    // The move transaction: the advisory lock, the preference row, the notice row.
    const trxOf = ({ locked = true, prefsRow, notice = null } = {}) => {
      const calls = [];
      const trx = (table) => {
        const chain = {
          where: () => chain, whereRaw: () => chain, orderBy: () => chain,
          forShare: () => { calls.push(`forShare:${table}`); return chain; },
          first: async () => (table === 'notifications' ? notice : prefsRow),
        };
        return chain;
      };
      trx.raw = async (sql, bindings) => {
        calls.push(['raw', sql, bindings]);
        if (locked instanceof Error) throw locked;
        if (!locked) throw Object.assign(new Error('could not obtain lock on row'), { code: '55P03' });
        return { rows: [{ id: 'c1' }] };
      };
      trx.calls = calls;
      return trx;
    };
    const proofreaderIndex = require('../services/auto-dispatch/proofreader');
    const approved = () => ({ proofread: true, prefs: scored(), approvedRecordPrint: null });
    const guard = (trx, config = approved()) => nightly.assertStillApproved(trx, SERVICE, config, refuse);
    const superseded = (err) => nightly.approvedSlotTaken({ allowed: true }, err);
    afterEach(() => jest.restoreAllMocks());

    test('nothing changed: the move goes on; the customer row was locked first, then both rows read FOR SHARE', async () => {
      const trx = trxOf();
      await expect(guard(trx)).resolves.toBeUndefined();
      expect(trx.calls[0]).toEqual(['raw', 'SELECT id FROM customers WHERE id = ? FOR UPDATE NOWAIT', ['c1']]);
      expect(trx.calls.slice(1)).toEqual(['forShare:property_preferences', 'forShare:notifications']);
    });

    test('another write holds the customer row: superseded, nothing is waited on; any other lock error is a failure', async () => {
      const err = await guard(trxOf({ locked: false })).catch((e) => e);
      expect(superseded(err)).toMatchObject({ reason_code: 'SUPERSEDED_DURING_RUN', reason_description: expect.stringContaining('was being changed') });
      expect(superseded(await guard(trxOf({ locked: new Error('connection lost') })).catch((e) => e))).toBeNull();
    });

    test('a new preferred day since the check: superseded, not a failure', async () => {
      const err = await guard(trxOf({ prefsRow: { preferred_day: 'tuesday' } })).catch((e) => e);
      expect(superseded(err)).toEqual({ reason_code: 'SUPERSEDED_DURING_RUN', reason_description: 'The customer\'s scheduling preferences changed while the move was checked' });
    });

    test('a person marked the notice done after the last read: superseded', async () => {
      const err = await guard(trxOf({ notice: PERSON_DONE })).catch((e) => e);
      expect(superseded(err)).toMatchObject({ reason_description: 'A person marked the held-move notice done while the move was checked' });
      // An OPEN notice is locked too (FOR SHARE whatever its state), so a Done cannot land before the move commits.
      const open = trxOf({ notice: { ...PERSON_DONE, done_at: null, done_by: null } });
      await expect(guard(open)).resolves.toBeUndefined();
      expect(open.calls).toContain('forShare:notifications');
    });

    test('the customer record is built again on the transaction: a new entry is superseded, the same record passes', async () => {
      const build = jest.spyOn(proofreaderIndex, 'buildCustomerRecord');
      const print = async () => { const run = runOf(); return (await check(run, proofreaderOf({ verdict: 'allow', why: 'nothing_breaks' }))).recordPrint; };
      const config = { ...approved(), approvedRecordPrint: await print() };
      build.mockResolvedValue(RECORD);
      await expect(guard(trxOf(), config)).resolves.toBeUndefined();
      build.mockResolvedValue({ ...RECORD, entries: [...RECORD.entries, { id: 'E2', channel: 'text', from: 'customer', at: 'now', text: 'Not Thursday.' }] });
      expect(superseded(await guard(trxOf(), config).catch((e) => e))).toMatchObject({ reason_description: 'The customer record changed while the move was checked' });
      // A record that cannot be read is a failure the run reports, never "superseded".
      build.mockResolvedValue({ ...RECORD, unread: [{ channel: 'text', reason: 'read_failed' }] });
      expect(superseded(await guard(trxOf(), config).catch((e) => e))).toBeNull();
    });

    test('the visit belongs to another customer since the check (a merge): superseded before anything is read', async () => {
      const trx = trxOf();
      const err = await nightly.assertStillApproved(trx, SERVICE, approved(), refuse, { ...SERVICE, customer_id: 'c2' }).catch((e) => e);
      expect(superseded(err)).toMatchObject({ reason_description: 'The visit changed customers while the move was checked' });
      expect(trx.calls).toEqual([]);
    });

    test('a move that was not proofread reads nothing', async () => {
      const trx = jest.fn();
      trx.raw = jest.fn();
      await nightly.assertStillApproved(trx, SERVICE, { prefs: scored() }, refuse);
      expect(trx).not.toHaveBeenCalled();
      expect(trx.raw).not.toHaveBeenCalled();
    });
  });

  test('check off: the fallback is unchanged', () => {
    expect(nightly.writeOptions(null, fallback)).toBe(fallback);
  });
  test('a taken approved slot, or a visit a person changed while the model read, is not a failure; a partial move is', () => {
    const err = (code, extra = {}) => Object.assign(new Error('x'), { code, ...extra });
    expect(nightly.approvedSlotTaken({ allowed: true }, err('SLOT_TAKEN'))).toMatchObject({ reason_code: 'APPROVED_SLOT_TAKEN' });
    expect(nightly.approvedSlotTaken({ allowed: true }, err('STALE_PLACEMENT'))).toMatchObject({ reason_code: 'SUPERSEDED_DURING_RUN' });
    expect(nightly.approvedSlotTaken(null, err('SLOT_TAKEN'))).toBeNull();
    expect(nightly.approvedSlotTaken({ allowed: true }, err('SLOT_TAKEN', { movedCount: 1 }))).toBeNull();
    expect(nightly.approvedSlotTaken({ allowed: true }, err('STALE_PLACEMENT', { failedMembers: ['s2'] }))).toBeNull();
    expect(nightly.approvedSlotTaken({ allowed: true }, err('VISIT_MEMBER_AUTO_DISPATCH_GUARD'))).toBeNull();
    // The check's own refusal of a visit that joined a stop meanwhile: a change during the check.
    let joined;
    try { nightly.assertNotGrouped([{ id: 's1' }, { id: 's2' }], true, (id, why) => err('VISIT_MEMBER_AUTO_DISPATCH_GUARD', { message: `${id} ${why}` }), 's1'); } catch (e) { joined = e; }
    expect(nightly.approvedSlotTaken({ allowed: true }, joined)).toMatchObject({ reason_code: 'SUPERSEDED_DURING_RUN', reason_description: 'The visit joined a grouped stop while the move was checked' });
  });
});


describe('closeNotices', () => {
  // The notification store as the close writes it: every builder call, in order.
  const recorder = (calls, { fail = false } = {}) => (table) => {
    calls.push(['table', table]);
    const q = new Proxy({}, {
      get: (_t, prop) => (prop === 'then' ? undefined : (...args) => {
        calls.push([prop, ...args]);
        if (prop !== 'update') return q;
        return fail ? Promise.reject(new Error('store down')) : Promise.resolve(1);
      }),
    });
    return q;
  };

  test('a notice, open or done, retires once its visit left the placement it is about or is no longer open', async () => {
    db.mockImplementationOnce(recorder([]));
    await nightly.closeNotices(new Date());
    const q = { whereRaw: jest.fn(() => q), whereIn: jest.fn(() => q) };
    const [spec] = audit.retireResolvedNotices.mock.calls[0];
    spec.stillOpen(q);
    const sql = q.whereRaw.mock.calls[0][0];
    expect(sql).toContain("metadata->>'scheduledDate'");
    expect(sql).toContain("s.window_start::text IS NOT DISTINCT FROM notifications.metadata->>'windowStart'");
    expect(sql).toContain("s.technician_id::text IS NOT DISTINCT FROM notifications.metadata->>'technicianId'");
    expect(sql).toContain("s.customer_id::text IS NOT DISTINCT FROM notifications.metadata->>'customerId'");
    expect(q.whereIn).toHaveBeenCalledWith('s.status', ['pending', 'confirmed']);
    expect(spec).toMatchObject({ keyPattern: 'auto-dispatch-proofreader:%', resolvedTitle: nightly.RESOLVED_TITLE, resolution: 'The visit moved or is no longer open' });
  });

  test('every run closes the notices still open from before, and never one a person marked done', async () => {
    const calls = [];
    db.mockImplementationOnce(recorder(calls));
    await expect(nightly.closeNotices(new Date('2026-10-30T08:10:00Z'))).resolves.toBe(true);
    expect(calls).toContainEqual(['table', 'notifications']);
    expect(calls).toContainEqual(['where', { recipient_type: 'admin', category: 'schedule_conflict' }]);
    expect(calls).toContainEqual(['whereNot', 'title', nightly.RESOLVED_TITLE]);
    // A notice a person marked done is left as it is: it still holds its visit (personHeld).
    expect(calls).toContainEqual(['whereNull', 'done_at']);
    expect(calls).toContainEqual(['whereRaw', "metadata->>'dedupeKey' LIKE ?", ['auto-dispatch-proofreader:%']]);
    expect(calls.find(([name]) => name === 'update')[1]).toMatchObject({ title: nightly.RESOLVED_TITLE, detail: null, done_by: 'auto-dispatch' });
    // After the placement retirement, which is what retires an old Done.
    expect(audit.retireResolvedNotices).toHaveBeenCalledTimes(1);
  });

  test('the check turned off: every notice closes, the done ones too', async () => {
    await expect(nightly.closeNotices(new Date(), { enabled: false })).resolves.toBe(true);
    const q = { whereRaw: jest.fn(() => q) };
    const [spec] = audit.retireResolvedNotices.mock.calls[0];
    spec.stillOpen(q);
    expect(q.whereRaw).toHaveBeenCalledWith('1 = 0');
    expect(spec).toMatchObject({ keyPattern: 'auto-dispatch-proofreader:%', resolvedTitle: nightly.RESOLVED_TITLE, resolution: 'The move check is turned off' });
    expect(db).not.toHaveBeenCalled();
  });

  test('a failed close is logged and never throws, and the run is not green', async () => {
    db.mockImplementationOnce(recorder([], { fail: true }));
    await expect(nightly.closeNotices(new Date())).resolves.toBe(false);
    audit.retireResolvedNotices.mockRejectedValueOnce(new Error('close down'));
    await expect(nightly.closeNotices(new Date())).resolves.toBe(false);
    audit.retireResolvedNotices.mockRejectedValueOnce(new Error('close down'));
    await expect(nightly.closeNotices(new Date(), { enabled: false })).resolves.toBe(false);
    expect(nightly.statusAfterNotices('completed', false)).toBe('completed_with_errors');
    expect(nightly.statusAfterNotices('completed', true)).toBe('completed');
    expect(nightly.statusAfterNotices('failed', false)).toBe('failed');
  });
});
