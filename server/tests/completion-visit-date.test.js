// GATE_COMPLETION_MOVES_DATE: the decision rules and the "writes nothing"
// guards. The DB behavior (visit, record, invoice, series, job costing) is
// proven in completion-visit-date-postgres.test.js.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { planCompletionDateMove, moveCompletedVisitToWorkDay, earlyCloseoutInvoiceDate } = require('../services/completion-visit-date');
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

  test('gate off writes and reads nothing', async () => {
    const out = await moveCompletedVisitToWorkDay(explodingTrx(), { scheduledServiceId: 'v', serviceRecord: { id: 'r', service_date: '2026-10-01' }, previousStatus: 'confirmed' });
    expect(out).toEqual({ moved: false, reason: 'gate_off' });
  });

  test('gate on but the column is missing (migration not run): nothing moves', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const out = await moveCompletedVisitToWorkDay(explodingTrx(), {
      scheduledServiceId: 'v', serviceRecord: { id: 'r', service_date: '2026-10-01' }, previousStatus: 'confirmed', scheduledServiceCols: { scheduled_date: {} },
    });
    expect(out).toEqual({ moved: false, reason: 'column_missing' });
  });

  // A trx whose scheduled_services row is `row` and whose update/partner calls are recorded.
  function trxFor(row, { partner = null } = {}) {
    const updates = [];
    const trx = (table) => {
      const chain = {
        where() { return chain; }, whereNot() { return chain; }, whereNotIn() { return chain; }, whereNull() { return chain; }, whereRaw() { return chain; }, forUpdate() { return chain; },
        first: async () => (table === 'scheduled_services' && !chain._partnerQuery ? row : partner),
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

  test('a visit grouped with a live partner keeps its date', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const trx = trxFor({ ...base, visit_id: 'stop-1' }, { partner: { id: 'p' } });
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
  test('gate on, work day before the booked day: the booked and work days', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    expect(await earlyCloseoutInvoiceDate(runnerFor(visit), { project, scheduledServiceId: 'v', today }))
      .toMatchObject({ from: '2026-10-08', to: '2026-10-05' });
  });
  test('gate on: late, same-day, future, rescheduled and grouped visits keep the default date', async () => {
    process.env.GATE_COMPLETION_MOVES_DATE = 'true';
    const run = (v, p = project, partner = null) => earlyCloseoutInvoiceDate(runnerFor(v, partner), { project: p, scheduledServiceId: 'v', today });
    expect(await run({ ...visit, scheduled_date: '2026-10-01' })).toBeNull();
    expect(await run({ ...visit, scheduled_date: '2026-10-05' })).toBeNull();
    expect(await run(visit, { project_date: '2026-10-07' })).toBeNull();
    expect(await run({ ...visit, status: 'rescheduled' })).toBeNull();
    expect(await run({ ...visit, visit_id: 'stop-1' }, project, { id: 'p' })).toBeNull();
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

describe('redateUndeliveredDraft scope', () => {
  const { redateUndeliveredDraft } = require('../services/completion-visit-date');
  test('only this visit\'s own invoice: same customer, and no other visit linked', async () => {
    const wheres = [];
    const nested = [];
    const chain = {
      where(arg) {
        if (typeof arg === 'function') {
          const b = { whereNull: (c) => { nested.push(['null', c]); return b; }, orWhere: (o) => { nested.push(['or', o]); return b; } };
          arg(b);
        } else wheres.push(arg);
        return chain;
      },
      whereNull() { return chain; },
      whereRaw() { return chain; },
      update: async () => 1,
    };
    const runner = () => chain;
    runner.fn = { now: () => 'now()' };
    const out = await redateUndeliveredDraft(runner, { id: 'inv-1', service_date: '2026-10-08' }, { from: '2026-10-08', to: '2026-10-05', scheduledServiceId: 'v-1', customerId: 'c-1' });
    expect(out.service_date).toBe('2026-10-05');
    expect(wheres).toEqual(expect.arrayContaining([{ id: 'inv-1' }, { customer_id: 'c-1' }, { status: 'draft' }]));
    expect(nested).toEqual([['null', 'scheduled_service_id'], ['or', { scheduled_service_id: 'v-1' }]]);
  });
});
