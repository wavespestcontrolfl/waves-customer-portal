/**
 * Post-cancel counted-plan reseed — BEHAVIOURAL coverage of the split
 * writer in routes/admin-schedule.js (fallback auditor P1 on 6d4bde826f:
 * the source guards in recurring-series-cancel-reseed.test.js pin shape
 * and order, but an unresolved helper — a renamed import, a typo'd
 * identifier — would only surface at runtime). Every helper is driven
 * here against a scripted connection (same harness shape as
 * recurring-series-topup.test.js), so each refusal path and the
 * term / probe / stamp helpers actually execute.
 */
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: jest.fn(async () => ({ synthesized: true, billingType: null })),
}));
jest.mock('../services/appointment-reminders', () => ({
  registerAppointment: jest.fn().mockResolvedValue(undefined),
  resolveCommittedVisitTime: jest.fn(async () => null),
  alertRegistrationFailure: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../services/scheduling/occupancy', () => ({
  ...jest.requireActual('../services/scheduling/occupancy'),
  findConflictingVisits: jest.fn(),
}));
jest.mock('../services/cancellation-processor', () => ({
  ...jest.requireActual('../services/cancellation-processor'),
  familyOfServiceRow: jest.fn(() => null),
}));
jest.mock('../services/annual-prepay-renewals', () => ({
  ...jest.requireActual('../services/annual-prepay-renewals'),
  coveredTermsAsOf: jest.fn(),
}));
jest.mock('../services/recurring-appointment-seeder', () => ({
  ...jest.requireActual('../services/recurring-appointment-seeder'),
  findActiveRecurringSeries: jest.fn(),
  sourceEstimateForScope: jest.fn(),
}));
jest.mock('../services/estimate-converter', () => ({
  buildSeriesAddressScope: jest.fn(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const adminScheduleRouter = require('../routes/admin-schedule');
const {
  reseedRecurringSeriesAfterCancel, reseedRecurringSeriesAfterCancelBatch,
  readReseedCandidate, reseedRefusal, reseedTermShortfall, probeReseedOverlaps, stampReseed,
  RESEED_STALE_READ_ATTEMPTS,
} = adminScheduleRouter._test;
const { findConflictingVisits } = require('../services/scheduling/occupancy');
const logger = require('../services/logger');

// Minimal scriptable conn: resolves terminal ops through a handler and is
// callable AS a transaction (same shape as the top-up suite's).
function makeConn(handler, { rawLocked = true } = {}) {
  const buildTable = (table) => {
    const calls = [];
    const b = {};
    const record = (name) => (...args) => {
      if ((name === 'where' || name === 'whereNotExists') && typeof args[0] === 'function') {
        const nested = [];
        const sub = {};
        for (const nm of ['where', 'orWhere', 'whereIn', 'whereNull', 'whereNotNull', 'orWhereNull', 'orWhereNot', 'whereRaw', 'orWhereRaw', 'orWhereNotIn', 'orWhereNotNull']) {
          sub[nm] = (...a) => { nested.push([nm, ...a]); return sub; };
        }
        args[0].call(sub, sub);
        calls.push(['whereFn', nested]);
      } else {
        calls.push([name, ...args]);
      }
      return b;
    };
    for (const m of ['where', 'orWhere', 'whereIn', 'whereNotIn', 'whereBetween', 'whereNull', 'whereNotNull', 'whereNot', 'whereRaw', 'orWhereRaw', 'orderBy', 'select', 'forUpdate', 'forNoKeyUpdate', 'limit', 'count', 'update', 'del', 'groupBy', 'distinct', 'leftJoin', 'join']) {
      b[m] = record(m);
    }
    b.modify = (fn) => { fn(b); return b; };
    b.first = (...args) => { calls.push(['first', ...args]); return Promise.resolve(handler({ table, calls, op: 'first' })); };
    b.pluck = (field) => { calls.push(['pluck', field]); return Promise.resolve(handler({ table, calls, op: 'pluck', field })); };
    b.columnInfo = () => Promise.resolve(handler({ table, calls, op: 'columnInfo' }));
    b.insert = (data) => {
      calls.push(['insert', data]);
      return {
        returning: () => Promise.resolve(handler({ table, calls, op: 'insertReturning', data })),
        then: (res, rej) => Promise.resolve(handler({ table, calls, op: 'insert', data })).then(res, rej),
      };
    };
    b.then = (res, rej) => Promise.resolve(handler({ table, calls, op: 'await' })).then(res, rej);
    return b;
  };
  const build = (isTransaction) => {
    const fn = (table) => buildTable(table);
    fn.isTransaction = isTransaction;
    fn.raw = jest.fn(() => Promise.resolve({ rows: [{ locked: rawLocked }] }));
    fn.fn = { now: () => new Date() };
    fn.transaction = (cb) => Promise.resolve().then(() => cb(build(true)));
    return fn;
  };
  return build(false);
}

const COLS = { recurring_ongoing: {}, skip_weekends: {}, weekend_shift: {}, service_id: {}, create_invoice_on_complete: {} };
const PARENT = {
  id: 10, customer_id: 5, is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: false,
  scheduled_date: '2026-07-10', window_start: '08:00', window_end: '09:00', estimated_duration_minutes: 60,
  service_type: 'Quarterly Pest Control Service', recurring_parent_id: null,
};
const CANCELLED = { id: 22, customer_id: 5, is_recurring: true, recurring_parent_id: 10, status: 'cancelled', scheduled_date: '2026-10-05' };

// A scenario handler: every table the refusal path reads, scripted.
function scenario(over = {}) {
  const s = {
    cancelled: CANCELLED, transition: { from_status: 'confirmed' }, parent: PARENT,
    decisions: [], stamp: null,
    customer: { id: 5, active: true, deleted_at: null, service_paused_at: null, pipeline_stage: 'active_customer' },
    ...over,
  };
  const inserted = [];
  const handler = ({ table, calls, op, data }) => {
    if (table === 'scheduled_services') {
      if (op === 'columnInfo') return COLS;
      if (op === 'first') {
        const where = calls.find((c) => c[0] === 'where' && c[1] && typeof c[1] === 'object');
        // ids reach the writer as strings from the batch (String(id)) and as numbers from the direct callers
        if (String(where?.[1]?.id) === String(CANCELLED.id)) return s.cancelled;
        if (String(where?.[1]?.id) === String(PARENT.id)) return s.parent;
        return undefined;
      }
      if (op === 'await') return s.seriesRows || [];
      if (op === 'insertReturning') { inserted.push(data); return [{ id: 900 + inserted.length, ...data }]; }
      return [];
    }
    if (table === 'job_status_history') {
      if (op === 'first') return s.transition;
      if (op === 'await') return s.transitions || (s.transition ? [{ job_id: CANCELLED.id, from_status: s.transition.from_status }] : []);
    }
    if (table === 'recurring_plan_alerts') return op === 'await' ? s.decisions : null;
    if (table === 'activity_log') {
      if (op === 'first') return s.stamp;
      if (op === 'await') return s.stamps || [];
      if (op === 'insert') { inserted.push({ __table: 'activity_log', ...data }); return [1]; }
    }
    if (table === 'customers') return op === 'first' ? s.customer : null;
    return null;
  };
  return { handler, inserted, s };
}

describe('readReseedCandidate — the audited transition decides', () => {
  test.each([
    ['not_found', { cancelled: undefined }],
    ['not_cancelled', { cancelled: { ...CANCELLED, status: 'pending' } }],
    ['not_plan_visit', { cancelled: { ...CANCELLED, is_recurring: false } }], // an explicit booster
    ['no_transition_record', { transition: undefined }],
    ['non_counting_transition', { transition: { from_status: 'rescheduled' } }],
  ])('%s', async (skipped, over) => {
    const { handler } = scenario(over);
    const trx = makeConn(handler);
    const out = await readReseedCandidate(trx, CANCELLED.id);
    expect(out.skipped).toBe(skipped);
  });

  test('a counting transition (and a legacy NULL source status, and a null-flagged legacy child) passes', async () => {
    for (const over of [
      {},
      { transition: { from_status: null } },
      { cancelled: { ...CANCELLED, is_recurring: null } },
    ]) {
      const { handler } = scenario(over);
      const out = await readReseedCandidate(makeConn(handler), CANCELLED.id);
      expect(out.skipped).toBeUndefined();
      expect(out.cancelled.id).toBe(CANCELLED.id);
    }
  });
});

describe('reseedRefusal — every refusal actually executes', () => {
  test.each([
    ['series_stopped', { decisions: [{ recurring_parent_id: 10, resolved_action: 'cancel_series' }] }, {}],
    ['already_reseeded', { stamp: { id: 'stamp-1' } }, {}],
    ['customer_churned', { customer: { id: 5, active: true, deleted_at: null, service_paused_at: null, pipeline_stage: 'churned' } }, {}],
    ['customer_inactive', { customer: { id: 5, active: false, deleted_at: null, service_paused_at: null, pipeline_stage: 'active_customer' } }, {}],
    ['annual_prepay_busy', {}, { rawLocked: false }],
  ])('%s', async (reason, over, connOpts) => {
    const { handler } = scenario(over);
    const trx = makeConn(handler, connOpts);
    expect(await reseedRefusal(trx, { parent: PARENT, parentId: PARENT.id, cancelledServiceId: CANCELLED.id, cols: COLS })).toBe(reason);
  });

  test('the prepay try-lock is the annual-prepay namespace keyed on the customer, taken on the trx', async () => {
    const { handler } = scenario();
    const trx = makeConn(handler, { rawLocked: false });
    await reseedRefusal(trx, { parent: PARENT, parentId: PARENT.id, cancelledServiceId: CANCELLED.id, cols: COLS });
    const { ANNUAL_PREPAY_LOCK_NS } = require('../routes/admin-customers')._private;
    expect(trx.raw).toHaveBeenCalledWith('SELECT pg_try_advisory_xact_lock(?, hashtext(?)) AS locked', [ANNUAL_PREPAY_LOCK_NS, String(PARENT.customer_id)]);
  });
});

describe('reseedTermShortfall — term by plan position, stamps pin earlier re-adds, upcoming from the plan rows', () => {
  const rows = (n, extra = []) => [
    { id: 10, status: 'completed', scheduled_date: '2026-07-10', is_recurring: true, recurring_parent_id: null },
    ...Array.from({ length: n }, (_, i) => ({ id: 100 + i, status: 'pending', scheduled_date: `2027-0${1 + (i % 6)}-1${i}`, is_recurring: true, recurring_parent_id: 10 })),
    ...extra,
  ];

  test('a whole term refuses; a short one with an upcoming row reports the shortfall', async () => {
    const whole = scenario({ seriesRows: rows(3) }); // 4 counting = quarterly's 4
    expect((await reseedTermShortfall(makeConn(whole.handler), { parent: PARENT, parentId: 10, cancelled: CANCELLED })).skipped).toBe('term_still_whole');
    const short = scenario({ seriesRows: rows(2) }); // 3 counting < 4
    const out = await reseedTermShortfall(makeConn(short.handler), { parent: PARENT, parentId: 10, cancelled: CANCELLED });
    expect(out.skipped).toBeUndefined();
    expect(out).toMatchObject({ counting: 3, expected: 4 });
    expect(out.window).toEqual({ index: 0, start: '2026-07-10', end: '2027-07-10' });
  });

  test('a cancelled last visit = the plan ended, no lone visit', async () => {
    const ended = scenario({ seriesRows: [{ id: 10, status: 'completed', scheduled_date: '2026-07-10', is_recurring: true, recurring_parent_id: null }] });
    expect((await reseedTermShortfall(makeConn(ended.handler), { parent: PARENT, parentId: 10, cancelled: CANCELLED })).skipped).toBe('no_live_visits');
  });

  test('an earlier reseed\'s stamp pins its added row to the term it served', async () => {
    // 3 counting by date in term 0, plus a re-added row dated in term 1 that the stamp says served term 0 → 4 → whole
    const stamped = scenario({
      seriesRows: rows(2, [{ id: 777, status: 'pending', scheduled_date: '2027-08-01', is_recurring: true, recurring_parent_id: 10 }]),
      stamps: [{ metadata: JSON.stringify({ added_service_ids: ['777'], term_index: 0 }) }],
    });
    expect((await reseedTermShortfall(makeConn(stamped.handler), { parent: PARENT, parentId: 10, cancelled: CANCELLED })).skipped).toBe('term_still_whole');
  });

  test('a moved exception is placed by its cadence date', async () => {
    const moved = { ...CANCELLED, scheduled_date: '2027-07-20', date_exception: true, date_exception_cadence_date: '2027-06-11' };
    const out = await reseedTermShortfall(makeConn(scenario({ seriesRows: rows(2) }).handler), { parent: PARENT, parentId: 10, cancelled: moved });
    expect(out.window.index).toBe(0);
  });
});

describe('probeReseedOverlaps + stampReseed', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the probe is advisory: a clash is logged and returned, the row is kept', async () => {
    findConflictingVisits.mockResolvedValueOnce([{ id: 'other' }]).mockResolvedValueOnce([]);
    const trx = makeConn(scenario().handler);
    const dates = await probeReseedOverlaps(trx, { parent: PARENT, parentId: 10, added: [{ id: 901, date: '2027-07-23' }, { id: 902, date: '2027-11-05' }] });
    expect(dates).toEqual(['2027-07-23']);
    expect(findConflictingVisits).toHaveBeenCalledWith(expect.objectContaining({ date: '2027-07-23', excludeServiceIds: [901], windowStart: '08:00', windowEnd: '09:00' }));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('a windowless template probes nothing', async () => {
    const dates = await probeReseedOverlaps(makeConn(scenario().handler), { parent: { ...PARENT, window_start: null }, parentId: 10, added: [{ id: 901, date: '2027-07-23' }] });
    expect(dates).toEqual([]);
    expect(findConflictingVisits).not.toHaveBeenCalled();
  });

  test('the stamp records the cancelled id, the added ids and the term it served', async () => {
    const { handler, inserted } = scenario();
    await stampReseed(makeConn(handler), {
      parent: PARENT, parentId: 10, cancelled: CANCELLED, cancelledServiceId: CANCELLED.id,
      added: [{ id: 901, date: '2027-07-23' }],
      term: { window: { index: 0, start: '2026-07-10', end: '2027-07-10' }, counting: 3, expected: 4 },
      overlapDates: [],
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0].action).toBe('recurring_cancel_reseed');
    expect(JSON.parse(inserted[0].metadata)).toMatchObject({ cancelled_service_id: '22', recurring_parent_id: '10', added_service_ids: ['901'], term_index: 0, counting: 3, expected: 4 });
  });
});

describe('the writing wrapper and the batch', () => {
  test('refuses a caller-open transaction', async () => {
    const trx = makeConn(scenario().handler);
    trx.isTransaction = true;
    await expect(reseedRecurringSeriesAfterCancel(trx, CANCELLED.id)).rejects.toThrow(/must not be called with an already-open transaction/);
  });

  test('a refusal path runs end-to-end through the locks and returns the reason', async () => {
    const { handler } = scenario({ decisions: [{ recurring_parent_id: 10, resolved_action: 'let_lapse' }] });
    const out = await reseedRecurringSeriesAfterCancel(makeConn(handler), CANCELLED.id, { source: 'test' });
    expect(out).toMatchObject({ added: [], skipped: 'series_stopped' });
  });

  test('the batch keeps only audited counting cancels, treats 2+ of one plan as a reduction, and isolates a failing root', async () => {
    const { handler } = scenario({
      transitions: [{ job_id: 22, from_status: 'confirmed' }, { job_id: 23, from_status: 'rescheduled' }],
      decisions: [{ recurring_parent_id: 10, resolved_action: 'cancel_series' }],
    });
    const conn = makeConn((q) => {
      if (q.table === 'scheduled_services' && q.op === 'await') {
        return [{ id: 22, is_recurring: true, recurring_parent_id: 10 }, { id: 23, is_recurring: true, recurring_parent_id: 10 }];
      }
      return handler(q);
    });
    // 23's transition was rescheduled→cancelled: filtered out, so root 10 has ONE real cancel and is evaluated (then refused: stopped)
    const out = await reseedRecurringSeriesAfterCancelBatch(conn, [22, 23], { source: 'test' });
    expect(out.skippedRoots).toEqual([]);
    expect(out.results).toHaveLength(1);
    expect(out.results[0].skipped).toBe('series_stopped');
  });

  test('RESEED_STALE_READ_ATTEMPTS is a small positive bound', () => {
    expect(RESEED_STALE_READ_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(RESEED_STALE_READ_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});
