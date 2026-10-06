// GATE_COMPLETION_MOVES_DATE: the decision rules and the "writes nothing"
// guards. The DB behavior (visit, record, invoice, series, job costing) is
// proven in completion-visit-date-postgres.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { planCompletionDateMove, moveCompletedVisitToWorkDay, moveCompletedVisitToWorkDaySafe, publishVisitDateMove, earlyCloseoutInvoiceDate } = require('../services/completion-visit-date');
const { completionMovesDateLive } = require('../config/feature-gates');

afterEach(() => { delete process.env.GATE_COMPLETION_MOVES_DATE; });

describe('planCompletionDateMove', () => {
  const today = '2026-10-06';
  test('moves only a work day strictly before the booked day', () => {
    expect(planCompletionDateMove({ bookedDate: '2026-10-08', workDate: '2026-10-05', previousStatus: 'confirmed', today }))
      .toEqual({ move: true, from: '2026-10-08', to: '2026-10-05' });
  });
  test('a late closeout keeps its booked day', () => {
    expect(planCompletionDateMove({ bookedDate: '2026-10-01', workDate: '2026-10-05', today }))
      .toMatchObject({ move: false, reason: 'late_completion' });
  });
  test('same day, missing dates, a future work day and a legacy rescheduled row do not move', () => {
    expect(planCompletionDateMove({ bookedDate: '2026-10-05', workDate: '2026-10-05', today })).toMatchObject({ move: false, reason: 'same_day' });
    expect(planCompletionDateMove({ bookedDate: null, workDate: '2026-10-05', today })).toMatchObject({ move: false, reason: 'no_date' });
    expect(planCompletionDateMove({ bookedDate: '2026-10-20', workDate: '2026-10-09', today })).toMatchObject({ move: false, reason: 'work_day_in_future' });
    expect(planCompletionDateMove({ bookedDate: '2026-10-08', workDate: '2026-10-05', previousStatus: 'rescheduled', today }))
      .toMatchObject({ move: false, reason: 'rescheduled_row' });
  });
  test('accepts Date objects as pg returns for DATE columns', () => {
    expect(planCompletionDateMove({ bookedDate: new Date('2026-10-08T00:00:00Z'), workDate: new Date('2026-10-05T00:00:00Z'), today }))
      .toMatchObject({ move: true, from: '2026-10-08', to: '2026-10-05' });
  });
});

describe('moveCompletedVisitToWorkDay guards', () => {
  // Any query at all fails the test: the gate-off path must touch nothing.
  const explodingTrx = () => { const t = () => { throw new Error('unexpected query'); }; t.fn = { now: () => 'now()' }; return t; };

  test('gate reader is strict true', () => {
    expect(completionMovesDateLive()).toBe(false);
    process.env.GATE_COMPLETION_MOVES_DATE = '1';
    expect(completionMovesDateLive()).toBe(false);
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    expect(completionMovesDateLive()).toBe(true);
  });

  test('gate off and no work-day invoice: nothing moves and nothing is written', async () => {
    const trx = trxFor({ ...base }, { invoiceFirsts: [null] });
    expect(await moveCompletedVisitToWorkDay(trx, args())).toEqual({ moved: false, reason: 'gate_off' });
    expect(trx.updates).toEqual([]);
  });

  test('gate turned off AFTER the invoice was minted with the work day: the started move is finished', async () => {
    // First invoices read = the marker (a non-void invoice already on the work day), second = the disagreement guard.
    const trx = trxFor({ ...base }, { invoiceFirsts: [{ id: 'inv' }, null] });
    expect(await moveCompletedVisitToWorkDay(trx, args())).toMatchObject({ moved: true, from: '2026-10-08', to: '2026-10-05' });
    expect(trx.updates.find((u) => u.table === 'scheduled_services').patch).toMatchObject({ scheduled_date: '2026-10-05' });
  });

  test('gate off with the marker still obeys every other rule (late closeout, grouped row, mismatch)', async () => {
    const late = trxFor({ ...base, scheduled_date: '2026-10-01' }, { invoiceFirsts: [{ id: 'inv' }, null] });
    expect(await moveCompletedVisitToWorkDay(late, args())).toMatchObject({ moved: false, reason: 'late_completion' });
    const grouped = trxFor({ ...base, visit_id: 'stop-1' }, { invoiceFirsts: [{ id: 'inv' }, null] });
    expect(await moveCompletedVisitToWorkDay(grouped, args())).toEqual({ moved: false, reason: 'grouped_visit' });
    const mismatch = trxFor({ ...base }, { invoiceFirsts: [{ id: 'inv' }, { id: 'other' }] });
    expect(await moveCompletedVisitToWorkDay(mismatch, args())).toEqual({ moved: false, reason: 'invoice_date_mismatch' });
    expect(late.updates.concat(grouped.updates, mismatch.updates)).toEqual([]);
  });

  test('gate on but the column is missing (migration not run): nothing moves', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const out = await moveCompletedVisitToWorkDay(explodingTrx(), {
      scheduledServiceId: 'v', serviceRecord: { id: 'r', service_date: '2026-10-01' }, previousStatus: 'confirmed', scheduledServiceCols: { scheduled_date: {} },
    });
    expect(out).toEqual({ moved: false, reason: 'column_missing' });
  });

  // A trx whose scheduled_services row is `row` and whose update/partner calls are recorded.
  function trxFor(row, { partner = null, stray = null, strayRecord = null, invoiceFirsts = null } = {}) {
    const updates = [];
    const queue = invoiceFirsts ? [...invoiceFirsts] : null;
    const trx = (table) => {
      const chain = {
        where() { return chain; }, whereNot() { return chain; }, whereNotIn() { return chain; }, whereNull() { return chain; }, whereNotNull() { return chain; }, whereRaw() { return chain; }, forUpdate() { return chain; },
        first: async () => (table === 'invoices' ? (queue && queue.length ? queue.shift() : stray) : table === 'service_records' ? strayRecord : (table === 'scheduled_services' && !chain._partnerQuery ? row : partner)),
        update: async (patch) => { updates.push({ table, patch }); return 1; },
      };
      const origWhereNot = chain.whereNot;
      chain.whereNot = () => { chain._partnerQuery = true; return origWhereNot(); };
      return chain;
    };
    trx.fn = { now: () => 'now()' };
    trx.updates = updates;
    return trx;
  }
  const cols = { original_scheduled_date: {}, updated_at: {}, visit_id: {}, date_exception: {} };
  const base = { id: 'v', status: 'completed', scheduled_date: '2026-10-08', original_scheduled_date: null, is_recurring: false, visit_id: null };
  const args = (over = {}) => ({ scheduledServiceId: 'v', serviceRecord: { id: 'r', service_date: '2026-10-05' }, previousStatus: 'confirmed', scheduledServiceCols: cols, today: '2026-10-06', ...over });

  test('a visit this closeout did not complete is left alone', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = trxFor({ ...base, status: 'confirmed' });
    expect(await moveCompletedVisitToWorkDay(trx, args())).toEqual({ moved: false, reason: 'not_completed' });
    expect(trx.updates).toEqual([]);
  });

  test('an invoice on any date other than the work day keeps the visit where it is; the record is not touched either', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = trxFor({ ...base }, { stray: { id: 'inv' } });
    expect(await moveCompletedVisitToWorkDay(trx, args())).toEqual({ moved: false, reason: 'invoice_date_mismatch' });
    expect(trx.updates).toEqual([]);
  });

  test('a service record on neither the booked day nor the work day keeps the visit where it is', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = trxFor({ ...base }, { strayRecord: { id: 'r' } });
    expect(await moveCompletedVisitToWorkDay(trx, args())).toEqual({ moved: false, reason: 'record_date_mismatch' });
    expect(trx.updates).toEqual([]);
  });

  test('the closeout never writes to invoices', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = trxFor({ ...base });
    expect(await moveCompletedVisitToWorkDay(trx, args())).toMatchObject({ moved: true });
    expect(trx.updates.map((u) => u.table)).not.toContain('invoices');
  });

  test('a row still attached to a visit group keeps its date, even with every sibling terminal', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = trxFor({ ...base, visit_id: 'stop-1' });
    expect(await moveCompletedVisitToWorkDay(trx, args())).toEqual({ moved: false, reason: 'grouped_visit' });
    expect(trx.updates).toEqual([]);
  });

  test('the first booked day is kept when a visit was already moved once', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = trxFor({ ...base, original_scheduled_date: '2026-10-12' });
    const out = await moveCompletedVisitToWorkDay(trx, args());
    expect(out).toMatchObject({ moved: true, from: '2026-10-08', to: '2026-10-05' });
    const visitPatch = trx.updates.find((u) => u.table === 'scheduled_services').patch;
    expect(visitPatch).toMatchObject({ scheduled_date: '2026-10-05', original_scheduled_date: '2026-10-12' });
  });
  test('the project work date wins over a reused record still on the booked day', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = trxFor({ ...base });
    const out = await moveCompletedVisitToWorkDay(trx, args({
      serviceRecord: { id: 'r', service_date: '2026-10-08' },
      workDate: '2026-10-04',
    }));
    expect(out).toMatchObject({ moved: true, from: '2026-10-08', to: '2026-10-04', recordDated: 1 });
    expect(trx.updates.find((u) => u.table === 'scheduled_services').patch).toMatchObject({ scheduled_date: '2026-10-04' });
    expect(trx.updates.find((u) => u.table === 'service_records').patch).toEqual({ service_date: '2026-10-04' });
  });

  test('without a work date the record date is used', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = trxFor({ ...base });
    expect(await moveCompletedVisitToWorkDay(trx, args({ workDate: null }))).toMatchObject({ moved: true, to: '2026-10-05' });
  });
});

describe('earlyCloseoutInvoiceDate (the project invoice is dated before delivery)', () => {
  const explode = () => { throw new Error('unexpected query'); };
  const cols = { original_scheduled_date: {}, visit_id: {} };
  const runnerFor = (visit, partner = null, columns = cols) => (table) => {
    const chain = {
      where() { return chain; }, whereNot() { chain._partner = true; return chain; }, whereNotIn() { return chain; },
      first: async () => (chain._partner ? partner : visit),
      columnInfo: async () => columns,
    };
    return chain;
  };
  const project = { project_date: '2026-10-05' };
  const visit = { id: 'v', status: 'confirmed', scheduled_date: '2026-10-08', visit_id: null };
  const today = '2026-10-06';

  test('gate off: no query, no date', async () => {
    expect(await earlyCloseoutInvoiceDate(explode, { project, scheduledServiceId: 'v', today })).toBeNull();
  });
  test('gate on, work day before the booked day: the work day', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    expect(await earlyCloseoutInvoiceDate(runnerFor(visit), { project, scheduledServiceId: 'v', today }))
      .toBe('2026-10-05');
  });
  test('gate on: late, same-day, future, rescheduled and grouped visits keep the default date', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const run = (v, p = project, partner = null) => earlyCloseoutInvoiceDate(runnerFor(v, partner), { project: p, scheduledServiceId: 'v', today });
    expect(await run({ ...visit, scheduled_date: '2026-10-01' })).toBeNull();
    expect(await run({ ...visit, scheduled_date: '2026-10-05' })).toBeNull();
    expect(await run(visit, { project_date: '2026-10-07' })).toBeNull();
    expect(await run({ ...visit, status: 'rescheduled' })).toBeNull();
    // The closeout's own status rule: a visit already finished or closed gets no early date.
    for (const status of ['completed', 'cancelled', 'skipped', 'no_show']) expect(await run({ ...visit, status })).toBeNull();
    expect(await run({ ...visit, visit_id: 'stop-1' })).toBeNull();
    expect(await earlyCloseoutInvoiceDate(runnerFor(visit), { project: {}, scheduledServiceId: 'v', today })).toBeNull();
    expect(await earlyCloseoutInvoiceDate(runnerFor(visit), { project, scheduledServiceId: null, today })).toBeNull();
  });
  test('gate on but original_scheduled_date is missing (migration not run): no date, so no invoice is dated for a move that cannot happen', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    expect(await earlyCloseoutInvoiceDate(runnerFor(visit, null, { scheduled_date: {} }), { project, scheduledServiceId: 'v', today })).toBeNull();
  });
});

describe('date reading', () => {
  test('a date that is not on the calendar is no date', () => {
    expect(planCompletionDateMove({ bookedDate: '2026-02-31', workDate: '2026-02-01', today: '2026-10-06' })).toMatchObject({ move: false, reason: 'no_date' });
    expect(planCompletionDateMove({ bookedDate: '2026-10-08T00:00:00.000Z', workDate: '2026-10-05', today: '2026-10-06' })).toMatchObject({ move: true, from: '2026-10-08' });
  });
});

describe('moveCompletedVisitToWorkDaySafe', () => {
  const markerTrx = (marker) => {
    const chain = { where() { return chain; }, whereRaw() { return chain; }, first: async () => marker };
    const trx = () => chain;
    trx.transaction = jest.fn(async () => ({ moved: false, reason: 'ran' }));
    return trx;
  };
  const safeArgs = { scheduledServiceId: 'v', serviceRecord: { id: 'r', service_date: '2026-10-05' }, workDate: '2026-10-05' };
  test('gate off and no work-day invoice: one read, no savepoint, no write', async () => {
    const trx = markerTrx(null);
    expect(await moveCompletedVisitToWorkDaySafe(trx, safeArgs)).toEqual({ moved: false, reason: 'gate_off' });
    expect(trx.transaction).not.toHaveBeenCalled();
  });
  test('gate off but a work-day invoice exists: the started move runs in its savepoint', async () => {
    const trx = markerTrx({ id: 'inv' });
    expect(await moveCompletedVisitToWorkDaySafe(trx, safeArgs)).toEqual({ moved: false, reason: 'ran' });
    expect(trx.transaction).toHaveBeenCalledTimes(1);
  });
  test('a failure inside the savepoint is logged and never thrown', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = { transaction: async () => { throw new Error('boom'); } };
    expect(await moveCompletedVisitToWorkDaySafe(trx, { scheduledServiceId: 'v' })).toEqual({ moved: false, reason: 'error' });
  });
});

describe('publishVisitDateMove', () => {
  const dispatch = require('../services/dispatch-assignment');
  afterEach(() => jest.restoreAllMocks());
  test('no move, no job: nothing is emitted', async () => {
    const spy = jest.spyOn(dispatch, 'emitDispatchJobUpdate').mockResolvedValue(null);
    expect(await publishVisitDateMove(null, { jobId: 'v' })).toBeNull();
    expect(await publishVisitDateMove({ moved: false, reason: 'late_completion' }, { jobId: 'v' })).toBeNull();
    expect(await publishVisitDateMove({ moved: true, from: '2026-10-08' }, {})).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  test('a move sends the board update with the vacated day; a failure never throws', async () => {
    const spy = jest.spyOn(dispatch, 'emitDispatchJobUpdate').mockResolvedValueOnce({ ok: 1 }).mockRejectedValueOnce(new Error('io down'));
    expect(await publishVisitDateMove({ moved: true, from: '2026-10-08' }, { jobId: 'v', actorId: 'a' })).toEqual({ ok: 1 });
    expect(spy).toHaveBeenCalledWith({ jobId: 'v', actorId: 'a', previousDate: '2026-10-08' });
    expect(await publishVisitDateMove({ moved: true, from: '2026-10-08' }, { jobId: 'v' })).toBeNull();
  });
});
