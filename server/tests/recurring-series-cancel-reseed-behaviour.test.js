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
  readReseedCandidate, reseedRefusal, reseedTermShortfall, probeReseedOverlaps, stampReseed, recordReseedDeclines, readBulkPlanReductionIntent,
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
        // the rung-6 owner re-lock reads first('customer_id'); a scenario can script a moving owner
        if (calls.some((c) => c[0] === 'first' && c[1] === 'customer_id') && s.relockOwners?.length) {
          return { customer_id: s.relockOwners.shift() };
        }
        // full-row reads of the cancelled row can be scripted in sequence (pre-lock read, then the re-validation under the fences)
        if (String(where?.[1]?.id) === String(CANCELLED.id) && s.cancelledReads?.length) return s.cancelledReads.shift();
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
      // full history newest first; a scripted row without to_status is a cancel row
      if (op === 'await') {
        const history = (s.transitions || (s.transition ? [{ job_id: CANCELLED.id, from_status: s.transition.from_status }] : []))
          .map((row) => ({ to_status: 'cancelled', ...row }));
        // honour the per-job filter the candidate read applies (the batch reads every id at once)
        const byJob = calls.find((c) => c[0] === 'where' && c[1] && typeof c[1] === 'object' && c[1].job_id != null);
        return byJob ? history.filter((row) => String(row.job_id) === String(byJob[1].job_id)) : history;
      }
    }
    if (table === 'recurring_plan_alerts') return op === 'await' ? s.decisions : null;
    if (table === 'activity_log') {
      if (op === 'first') {
        const byAction = calls.find((c) => c[0] === 'where' && c[1] && typeof c[1] === 'object' && c[1].action);
        return byAction?.[1].action === 'recurring_cancel_reseed_declined' ? (s.declined || null) : s.stamp;
      }
      if (op === 'await') {
        const byAction = calls.find((c) => c[0] === 'where' && c[1] && typeof c[1] === 'object' && c[1].action);
        return byAction?.[1].action === 'recurring_cancel_reseed_declined' ? (s.declines || []) : (s.stamps || []);
      }
      if (op === 'insert') { for (const row of [].concat(data)) inserted.push({ __table: 'activity_log', ...row }); return [1]; }
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
    // Codex r7: an older counting cancel compensated back to live, then a placeholder cancelled → only the CURRENT episode counts
    ['non_counting_transition', { transitions: [
      { job_id: 22, from_status: 'rescheduled', to_status: 'cancelled' },
      { job_id: 22, from_status: 'cancelled', to_status: 'pending' },
      { job_id: 22, from_status: 'confirmed', to_status: 'cancelled' },
    ] }],
    // newest row is not a cancel at all (compensated) → no current episode
    ['no_transition_record', { transitions: [{ job_id: 22, from_status: 'cancelled', to_status: 'pending' }, { job_id: 22, from_status: 'confirmed', to_status: 'cancelled' }] }],
    // a historical visit-count TRIM (its own audit note, no ledger row) replayed through dispatch / the Intelligence Bar
    ['visit_count_trim', { transitions: [
      { job_id: 22, from_status: 'cancelled', notes: 'Cancelled from the Intelligence Bar' },
      { job_id: 22, from_status: 'pending', notes: 'Recurring plan shortened to 3 visits from Edit appointment' },
    ] }],
  ])('%s', async (skipped, over) => {
    const { handler } = scenario(over);
    const trx = makeConn(handler);
    const out = await readReseedCandidate(trx, CANCELLED.id);
    expect(out.skipped).toBe(skipped);
  });

  test('a counting transition (and a legacy NULL source status, a null-flagged legacy child, and a replay row on top of the real cancel) passes', async () => {
    for (const over of [
      {},
      { transition: { from_status: null } },
      { cancelled: { ...CANCELLED, is_recurring: null } },
      // dispatch same-status retry: cancelled→cancelled replay row is newest, the real pending→cancelled sits under it
      { transitions: [{ job_id: 22, from_status: 'cancelled' }, { job_id: 22, from_status: 'pending' }] },
      // an OLDER trim compensated back to live, then a genuine single cancel: only the current episode's note counts
      { transitions: [
        { job_id: 22, from_status: 'confirmed', notes: 'Cancelled by office' },
        { job_id: 22, from_status: 'cancelled', to_status: 'pending' },
        { job_id: 22, from_status: 'pending', notes: 'Recurring plan shortened to 3 visits from Edit appointment' },
      ] },
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

  const ledgerEntry = (id, episode, batch) => ({ metadata: JSON.stringify({ cancelled_service_id: String(id), recurring_parent_id: '10', episode_key: episode, batch_ids: batch.map(String) }) });
  const refuse = (over) => {
    const sc = scenario(over);
    return { sc, run: () => reseedRefusal(makeConn(sc.handler), { parent: PARENT, parentId: PARENT.id, cancelledServiceId: CANCELLED.id, cols: COLS }) };
  };

  test('batch_series_cancel: its own ledger entry for THIS cancel episode refuses a later single-id replay (pre-push audit P1)', async () => {
    const { run } = refuse({
      declines: [ledgerEntry(22, 'E7', [22, 23])],
      transitions: [{ id: 'E7', job_id: 22, from_status: 'pending' }],
    });
    expect(await run()).toBe('batch_series_cancel');
  });

  test('completes_plan_reduction: named in a standing reduction it never got an entry for (its bulk cancel failed back then) → refused, and its own entry is recorded (Codex r10 P1)', async () => {
    const { sc, run } = refuse({
      declines: [ledgerEntry(21, 'E5', [21, 22])],
      transitions: [{ id: 'E5', job_id: 21, from_status: 'pending' }, { id: 'E9', job_id: 22, from_status: 'pending' }],
    });
    expect(await run()).toBe('completes_plan_reduction');
    const rows = sc.inserted.filter((row) => row.__table === 'activity_log');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].metadata)).toMatchObject({
      cancelled_service_id: '22', recurring_parent_id: '10', episode_key: 'E9', batch_ids: ['21', '22'], reason: 'batch_series_cancel', source: 'plan-reduction-completion',
    });
  });

  test('a reduction whose own row was since RESTORED no longer stands — the replay is judged on the normal rules', async () => {
    const { run } = refuse({
      declines: [ledgerEntry(21, 'E5', [21, 22])],
      // 21: cancelled in E5, then restored (newest row leaves 'cancelled') → no current episode
      transitions: [{ id: 'E6', job_id: 21, from_status: 'cancelled', to_status: 'pending' }, { id: 'E5', job_id: 21, from_status: 'pending' }, { id: 'E9', job_id: 22, from_status: 'pending' }],
      customer: { id: 5, active: false, deleted_at: null, service_paused_at: null, pipeline_stage: 'active_customer' },
    });
    // it got past the ledger to the customer rules
    expect(await run()).toBe('customer_inactive');
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
  // Relative dates only (fallback auditor P1 on 4a67afdc15): the helper
  // compares upcoming rows against TODAY, so absolute fixtures would rot.
  const daysOut = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const addYear = (d, y) => { const [Y, M, D] = d.split('-').map(Number); const t = new Date(Date.UTC(Y + y, M - 1, D)); if (t.getUTCMonth() !== M - 1) t.setUTCDate(0); return t.toISOString().slice(0, 10); };
  const ROOT = daysOut(-80);                 // term 0 = [ROOT, ROOT + 1y)
  const TERM0 = { index: 0, start: ROOT, end: addYear(ROOT, 1) };
  const parent = { ...PARENT, scheduled_date: ROOT };
  const cancelled = { ...CANCELLED, scheduled_date: daysOut(7) };
  // the cancelled row itself is part of the series (it keeps its slot)
  const rows = (n, extra = []) => [
    { id: 10, status: 'completed', scheduled_date: ROOT, is_recurring: true, recurring_parent_id: null },
    { ...CANCELLED, scheduled_date: daysOut(7) },
    ...Array.from({ length: n }, (_, i) => ({ id: 100 + i, status: 'pending', scheduled_date: daysOut(30 + 40 * i), is_recurring: true, recurring_parent_id: 10 })),
    ...extra,
  ];
  const run = (over, c = cancelled) => reseedTermShortfall(makeConn(scenario(over).handler), { parent, parentId: 10, cancelled: c });

  test('a cancelled slot leaves its term short (root + 2 of 4 slots counting); the window rides along for the stamp', async () => {
    const out = await run({ seriesRows: rows(2) }); // slots: root, cancelled, c0, c1 → 3 counting < 4
    expect(out.skipped).toBeUndefined();
    expect(out).toMatchObject({ counting: 3, expected: 4 });
    expect(out.window).toEqual(TERM0);
    // a 5th occurrence opens term 1 and never masks term 0
    const out2 = await run({ seriesRows: rows(3) });
    expect(out2).toMatchObject({ counting: 3, expected: 4 });
    expect(out2.window).toEqual(TERM0);
  });

  test('a cancelled last visit = the plan ended, no lone visit', async () => {
    expect((await run({ seriesRows: rows(0) })).skipped).toBe('no_live_visits');
  });

  test('an ONGOING plan whose only future visit was cancelled is refilled, not treated as ended (Codex r8 P1)', async () => {
    const ongoingParent = { ...parent, recurring_ongoing: true };
    const out = await reseedTermShortfall(makeConn(scenario({ seriesRows: rows(0) }).handler), { parent: ongoingParent, parentId: 10, cancelled });
    expect(out.skipped).toBeUndefined();
    expect(out).toMatchObject({ counting: 1, expected: 4, upcomingPlanCount: 0 });
  });

  test('the append anchor: a later occurrence cancelled without a replacement marks the end; a plan reduction does not (Codex r9 P1)', async () => {
    const later = { id: 102, status: 'cancelled', scheduled_date: daysOut(200), is_recurring: true, recurring_parent_id: 10 };
    const series = rows(1, [later]); // root, cancelled (day 7), live c0 (day 30), cancelled later (day 200)
    // single skip → the later cancelled date is the end; the add goes past it
    const skip = await run({ seriesRows: series, transitions: [{ id: 'E1', job_id: 102, from_status: 'pending' }] });
    expect(skip.anchorFloor).toEqual({ scheduled_date: daysOut(200) });
    // on the ledger for its CURRENT episode → a reduction; the plan ends at the live row
    const ledger = await run({
      seriesRows: series,
      transitions: [{ id: 'E1', job_id: 102, from_status: 'pending' }],
      declines: [{ metadata: JSON.stringify({ cancelled_service_id: '102', recurring_parent_id: '10', episode_key: 'E1' }) }],
    });
    expect(ledger.anchorFloor).toEqual({ scheduled_date: daysOut(30) });
    // a ledger row for an OLDER episode (un-cancelled, then single-cancelled again) does not count
    const stale = await run({
      seriesRows: series,
      transitions: [{ id: 'E3', job_id: 102, from_status: 'pending' }, { id: 'E2', job_id: 102, from_status: 'cancelled', to_status: 'pending' }, { id: 'E1', job_id: 102, from_status: 'pending' }],
      declines: [{ metadata: JSON.stringify({ cancelled_service_id: '102', recurring_parent_id: '10', episode_key: 'E1' }) }],
    });
    expect(stale.anchorFloor).toEqual({ scheduled_date: daysOut(200) });
    // a trim made before the ledger existed is recognised by its own audit note
    const trim = await run({
      seriesRows: series,
      transitions: [{ id: 'E1', job_id: 102, from_status: 'pending', notes: 'Recurring plan shortened to 3 visits from Edit appointment' }],
    });
    expect(trim.anchorFloor).toEqual({ scheduled_date: daysOut(30) });
  });

  test('the append anchor: a later cancel that COMPLETED a standing reduction (named in its batch, no entry of its own) is a reduction too (Codex r10 P1)', async () => {
    const series = rows(1, [
      { id: 102, status: 'cancelled', scheduled_date: daysOut(200), is_recurring: true, recurring_parent_id: 10 },
      { id: 103, status: 'cancelled', scheduled_date: daysOut(290), is_recurring: true, recurring_parent_id: 10 },
    ]);
    const transitions = [{ id: 'E1', job_id: 102, from_status: 'pending' }, { id: 'E2', job_id: 103, from_status: 'pending' }];
    // no ledger: both later cancels are single skips → the end is the last of them
    expect((await run({ seriesRows: series, transitions })).anchorFloor).toEqual({ scheduled_date: daysOut(290) });
    // 102's reduction named 103 too (103's cancel failed then, done later) → both are the reduction; the plan ends at the live row
    const out = await run({
      seriesRows: series, transitions,
      declines: [{ metadata: JSON.stringify({ cancelled_service_id: '102', recurring_parent_id: '10', episode_key: 'E1', batch_ids: ['102', '103'] }) }],
    });
    expect(out.anchorFloor).toEqual({ scheduled_date: daysOut(30) });
  });

  test('an auto-dispatched row is slotted by its due date, not its moved scheduled_date (Codex r8 P2)', async () => {
    // quarterly = 4 slots a term. Row 104 is due BEFORE the cancelled row (day 5) but auto-dispatch moved it
    // to day 9; by due date the cancelled row is the plan's 5th occurrence → term 1, not term 0.
    const series = [
      { id: 10, status: 'completed', scheduled_date: ROOT, is_recurring: true, recurring_parent_id: null },
      { id: 102, status: 'completed', scheduled_date: daysOut(-50), is_recurring: true, recurring_parent_id: 10 },
      { id: 103, status: 'completed', scheduled_date: daysOut(-20), is_recurring: true, recurring_parent_id: 10 },
      { id: 104, status: 'pending', scheduled_date: daysOut(9), recurring_dispatch_due_date: daysOut(5), is_recurring: true, recurring_parent_id: 10 },
      { ...CANCELLED, scheduled_date: daysOut(7) },
      { id: 105, status: 'pending', scheduled_date: daysOut(90), is_recurring: true, recurring_parent_id: 10 },
    ];
    const out = await run({ seriesRows: series });
    expect(out.window.index).toBe(1);
    expect(out).toMatchObject({ counting: 1, expected: 4 });
  });

  test("an earlier reseed's stamp pins its added row to the term it served", async () => {
    // 3 counting in term 0 (root + 2; the cancelled slot is empty), plus a re-added row the stamp pins to term 0 → 4 → whole
    const out = await run({
      seriesRows: rows(2, [{ id: 777, status: 'pending', scheduled_date: daysOut(400), is_recurring: true, recurring_parent_id: 10 }]),
      stamps: [{ metadata: JSON.stringify({ added_service_ids: ['777'], term_index: 0 }) }],
    });
    expect(out.skipped).toBe('term_still_whole');
  });

  test('cancelling a re-added visit takes its term from the stamp, not from its end-of-series date', async () => {
    // 777 was re-added for term 0 but dated in term 1; cancelling it must re-open term 0 (3 counting < 4), not term 1
    const readded = { ...CANCELLED, id: 777, scheduled_date: daysOut(400) };
    const out = await run({
      seriesRows: rows(2, [{ ...readded, status: 'cancelled' }]), // the slot 777 replaced is still empty
      stamps: [{ metadata: JSON.stringify({ added_service_ids: ['777'], term_index: 0 }) }],
    }, readded);
    expect(out.skipped).toBeUndefined();
    expect(out.window).toEqual(TERM0);
    expect(out.counting).toBe(3);
  });

  test('a moved exception is placed by its cadence date', async () => {
    const moved = { ...cancelled, scheduled_date: daysOut(400), date_exception: true, date_exception_cadence_date: daysOut(200) };
    const out = await run({ seriesRows: [...rows(2).filter((r) => r.id !== CANCELLED.id), { ...moved, status: 'cancelled' }] }, moved);
    expect(out.window).toEqual(TERM0);
    expect(out.counting).toBe(3);
  });

  test('a cancelled row that is not part of the plan sequence refuses', async () => {
    expect((await run({ seriesRows: rows(2) }, { ...cancelled, id: 'stranger' })).skipped).toBe('not_in_plan_sequence');
  });

  test('ordinal-weekday monthly: the 13th occurrence a day before the anniversary is term 1 (Codex r6)', async () => {
    const monthly = { ...parent, recurring_pattern: 'monthly_nth_weekday' };
    // 12 slots in term 0 (root + 11), a 13th just before the anniversary, the cancelled one among the first 12
    const series = [
      { id: 10, status: 'completed', scheduled_date: ROOT, is_recurring: true, recurring_parent_id: null },
      ...Array.from({ length: 11 }, (_, i) => ({ id: 100 + i, status: i === 3 ? 'cancelled' : 'pending', scheduled_date: daysOut(-80 + 30 * (i + 1)), is_recurring: true, recurring_parent_id: 10 })),
      { id: 200, status: 'pending', scheduled_date: daysOut(-80 + 364), is_recurring: true, recurring_parent_id: 10 },
    ];
    const out = await reseedTermShortfall(makeConn(scenario({ seriesRows: series }).handler), { parent: monthly, parentId: 10, cancelled: { ...cancelled, id: 103 } });
    expect(out.skipped).toBeUndefined();
    expect(out).toMatchObject({ counting: 11, expected: 12 });
    expect(out.window.index).toBe(0);
    expect(out.upcomingPlanCount).toBe(series.filter((r) => r.status === 'pending' && r.scheduled_date >= daysOut(0)).length);
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
  beforeEach(() => jest.clearAllMocks());

  test('refuses a caller-open transaction', async () => {
    const trx = makeConn(scenario().handler);
    trx.isTransaction = true;
    await expect(reseedRecurringSeriesAfterCancel(trx, CANCELLED.id)).rejects.toThrow(/must not be called with an already-open transaction/);
  });

  test('an owner that moves under the comms lock is re-locked; one that moves again defers (owner_changed_under_fence) and the wrapper retries', async () => {
    // relock reads: first says customer 6 (moved), second says 7 (moved again) → defer; retried thrice, then given up
    const owners = [];
    for (let i = 0; i < RESEED_STALE_READ_ATTEMPTS; i += 1) owners.push(6, 7);
    const { handler } = scenario({ relockOwners: owners, decisions: [{ recurring_parent_id: 10, resolved_action: 'cancel_series' }] });
    const out = await reseedRecurringSeriesAfterCancel(makeConn(handler), CANCELLED.id, { source: 'test' });
    expect(out.skipped).toBe('owner_changed_under_fence');
    expect(logger.warn).toHaveBeenCalledTimes(RESEED_STALE_READ_ATTEMPTS);
    // moved once and stable under the second lock → evaluated under the fresh owner (then refused: stopped)
    const { handler: settled } = scenario({
      relockOwners: [6, 6],
      // pre-lock read still shows the old owner; the re-validation under the fences shows the row moved with its root
      cancelledReads: [CANCELLED, { ...CANCELLED, customer_id: 6 }],
      parent: { ...PARENT, customer_id: 6 },
      decisions: [{ recurring_parent_id: 10, resolved_action: 'cancel_series' }],
    });
    expect((await reseedRecurringSeriesAfterCancel(makeConn(settled), CANCELLED.id, { source: 'test' })).skipped).toBe('series_stopped');
  });

  test('a refusal path runs end-to-end through the locks and returns the reason', async () => {
    const { handler } = scenario({ decisions: [{ recurring_parent_id: 10, resolved_action: 'let_lapse' }] });
    const out = await reseedRecurringSeriesAfterCancel(makeConn(handler), CANCELLED.id, { source: 'test' });
    expect(out).toMatchObject({ added: [], skipped: 'series_stopped' });
  });

  test('the batch keeps only audited counting cancels, treats 2+ of one plan as a reduction, and isolates a failing root', async () => {
    const { handler } = scenario({
      transitions: [
        { job_id: 22, from_status: 'confirmed' },
        // 23: a cancelled→cancelled replay on top of a rescheduled→cancelled — its current episode left 'rescheduled' → filtered out
        { job_id: 23, from_status: 'cancelled' }, { job_id: 23, from_status: 'rescheduled' },
      ],
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

  test('2+ counting cancels of one plan: no reseed, and the batch writes NO ledger rows of its own (the route wrote them in-trx)', async () => {
    const { handler, inserted } = scenario({
      transitions: [{ id: 71, job_id: 22, from_status: 'confirmed' }, { id: 72, job_id: 24, from_status: 'pending' }],
    });
    const conn = makeConn((q) => {
      if (q.table === 'scheduled_services' && q.op === 'await') {
        return [{ id: 22, is_recurring: true, recurring_parent_id: 10 }, { id: 24, is_recurring: true, recurring_parent_id: 10 }];
      }
      return handler(q);
    });
    const out = await reseedRecurringSeriesAfterCancelBatch(conn, [22, 24], { source: 'test' });
    expect(out.results).toEqual([]);
    expect(out.skippedRoots).toEqual([{ rootId: '10', cancelledIds: ['22', '24'], skipped: 'batch_series_cancel' }]);
    expect(inserted.filter((row) => row.__table === 'activity_log')).toHaveLength(0);
  });

  test('a retried bulk request: an already-cancelled row whose first reseed failed is re-evaluated on its own, and never turns a NEW single cancel of the same plan into a "reduction" (pre-push audit P1)', async () => {
    // 22 was cancelled by an earlier request (its reseed failed, no stamp); this request re-carries 22 and newly cancels 24
    const { handler } = scenario({
      transitions: [{ id: 81, job_id: 22, from_status: 'confirmed' }, { id: 82, job_id: 24, from_status: 'pending' }],
      decisions: [{ recurring_parent_id: 10, resolved_action: 'cancel_series' }], // any refusal proves the row was evaluated
    });
    const conn = makeConn((q) => {
      if (q.table === 'scheduled_services' && q.op === 'await') return [{ id: 24, is_recurring: true, recurring_parent_id: 10 }];
      return handler(q);
    });
    const out = await reseedRecurringSeriesAfterCancelBatch(conn, [24], { source: 'test', retryIds: [22, 24] });
    // 24 alone is a single cancel (not a batch reduction), and 22 is retried separately; 24 is not evaluated twice
    expect(out.skippedRoots).toEqual([]);
    expect(out.results).toHaveLength(2);
    // (the scripted conn serves a full row for 22 only, so 24's own evaluation stops at not_found; 22 reaches the stopped-plan refusal)
    expect(out.results.map((r) => r.skipped).sort()).toEqual(['not_found', 'series_stopped']);
    // retries alone still run
    const only = await reseedRecurringSeriesAfterCancelBatch(conn, [], { source: 'test', retryIds: [22] });
    expect(only.results).toHaveLength(1);
    expect(only.results[0].skipped).toBe('series_stopped');
  });

  test('readBulkPlanReductionIntent: a partially failed bulk reduction retried (same selection, or just the failed row) keeps its intent (Codex r10 P1)', async () => {
    const A = { id: 'A', customer_id: 5, status: 'cancelled', is_recurring: true, recurring_parent_id: 10 };
    const B = { id: 'B', customer_id: 5, status: 'pending', is_recurring: true, recurring_parent_id: 10 };
    const intentFor = async (selection, over) => {
      const { handler } = scenario(over);
      const conn = makeConn((q) => {
        if (q.table === 'scheduled_services' && q.op === 'await') return selection;
        return handler(q);
      });
      return readBulkPlanReductionIntent(conn, selection.map((row) => row.id));
    };
    const standing = {
      declines: [{ metadata: JSON.stringify({ cancelled_service_id: 'A', recurring_parent_id: '10', episode_key: 'eA', batch_ids: ['A', 'B'] }) }],
      transitions: [{ id: 'eA', job_id: 'A', from_status: 'pending' }],
    };
    // retried with the same selection: A is already cancelled, B is the late cancel → B is part of {A, B}
    expect((await intentFor([A, B], standing)).get('B')).toEqual({ rootId: '10', groupIds: ['A', 'B'], reductionKey: 'batch:A,B' });
    // retried with just the failed row
    expect((await intentFor([B], standing)).get('B')).toEqual({ rootId: '10', groupIds: ['A', 'B'], reductionKey: 'batch:A,B' });
    // an earlier reduction that did NOT name B → B is a stand-alone cancel
    const other = { ...standing, declines: [{ metadata: JSON.stringify({ cancelled_service_id: 'A', recurring_parent_id: '10', episode_key: 'eA', batch_ids: ['A', 'C'] }) }] };
    expect((await intentFor([B], other)).has('B')).toBe(false);
    // A since restored → the reduction no longer stands
    const restored = { ...standing, transitions: [{ id: 'eA2', job_id: 'A', from_status: 'cancelled', to_status: 'pending' }, { id: 'eA', job_id: 'A', from_status: 'pending' }] };
    expect((await intentFor([B], restored)).has('B')).toBe(false);
    // a fresh 2+ selection is still a reduction on its own
    const B2 = { ...B, id: 'B2' };
    const fresh = await intentFor([B, B2], {});
    expect(fresh.get('B')).toEqual({ rootId: '10', groupIds: ['B', 'B2'], reductionKey: expect.any(String) });
    // one key names the whole selection, so each row's entry names the same reduction
    expect(fresh.get('B2').reductionKey).toBe(fresh.get('B').reductionKey);
  });

  test('recordReseedDeclines: one row per cancelled visit, keyed on its CURRENT episode, carrying the whole reduction group', async () => {
    const { handler, inserted } = scenario({
      // job 22: an older cancel compensated back to live, then the current cancel (entering row 73)
      transitions: [{ id: 73, job_id: 22, from_status: 'pending' }, { id: 70, job_id: 22, from_status: 'cancelled', to_status: 'pending' }, { id: 69, job_id: 22, from_status: 'confirmed' }],
    });
    await recordReseedDeclines(makeConn(handler), {
      customerId: 5, rootId: 10, cancelledIds: [22], batchIds: [22, 24], reductionKey: 'K1', reason: 'batch_series_cancel', source: 'admin-schedule-bulk-cancel',
    });
    const rows = inserted.filter((row) => row.__table === 'activity_log');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ customer_id: 5, action: 'recurring_cancel_reseed_declined' });
    expect(rows[0].description).toMatch(/^2 visits of one recurring plan cancelled together/);
    expect(JSON.parse(rows[0].metadata)).toEqual({
      cancelled_service_id: '22', recurring_parent_id: '10', episode_key: '73',
      reason: 'batch_series_cancel', source: 'admin-schedule-bulk-cancel', batch_ids: ['22', '24'], reduction_key: 'K1',
    });
  });

  test('RESEED_STALE_READ_ATTEMPTS is a small positive bound', () => {
    expect(RESEED_STALE_READ_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(RESEED_STALE_READ_ATTEMPTS).toBeLessThanOrEqual(5);
  });
});
