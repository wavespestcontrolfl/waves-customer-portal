// Real PostgreSQL transaction (rolled back): open time (L11b, GATE_TECH_OPEN_TIME) on the migrated schema.
// The two charged-minutes columns on job_costs, a technician card, two completed visits costed with
// GATE_TECH_COST_RATES on, computeOpenTime on a card day and on a clock day (time_entry_daily_summary), a
// visit costed before the card left out, and the nightly re-cost picking up a GPS leg the trip link wrote
// after the visit was costed. All names are synthetic. DATABASE_URL-gated like the other *-postgres suites.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../services/ad-attribution-sync', () => ({
  syncCustomerAdAttribution: jest.fn().mockResolvedValue({}),
}));

const { randomUUID } = require('node:crypto');
const jobCosting = require('../services/job-costing');
const { computeOpenTime } = require('../services/open-time');
const { recostVisits, recostNightly } = require('../services/job-cost-recost');
const { loadVisitRates } = require('../services/tech-cost-rates');

jest.setTimeout(60000);
const COST_GATE = 'GATE_TECH_COST_RATES';
const OPEN_GATE = 'GATE_TECH_OPEN_TIME';
const TODAY = '2026-10-27';

postgres('open time on the migrated schema', () => {
  let database;
  let trx;
  const OLD = { [COST_GATE]: process.env[COST_GATE], [OPEN_GATE]: process.env[OPEN_GATE] };
  let techId;
  let customerId;

  const addVisit = async (over = {}) => {
    const id = randomUUID();
    await trx('scheduled_services').insert({
      id,
      customer_id: customerId,
      technician_id: techId,
      scheduled_date: '2026-10-26',
      service_type: 'Quarterly Pest Control Service',
      status: 'completed',
      estimated_price: 129,
      actual_start_time: '2026-10-26T14:00:00Z',
      actual_end_time: '2026-10-26T15:00:00Z', // 60 minutes on site
      ...over,
    });
    return id;
  };
  const addCard = (over = {}) => trx('technician_cost_cards').insert({
    technician_id: techId,
    effective_date: '2026-01-01',
    kind: 'w2',
    hourly_wage: 21,
    paid_hours_per_week: 40,
    paid_hours_per_day: 10,
    health_money_monthly: 200,
    retirement_pct: 2,
    workers_comp_pct: 4,
    paid_days_off_per_year: 15,
    ...over,
  }).returning('*').then((r) => r[0]);
  const jobCost = (id) => trx('job_costs').where({ scheduled_service_id: id }).first();
  const gatesOn = () => { process.env[COST_GATE] = 'true'; process.env[OPEN_GATE] = 'true'; };

  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = process.env.WAVES_DATABASE_ENVIRONMENT === 'test'
      && /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) && !privateQa) {
      throw new Error('Use an isolated local/CI database or labeled private QA database');
    }
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
  });
  beforeEach(async () => {
    trx = await database.transaction();
    mockConnection = trx;
    delete process.env[COST_GATE];
    delete process.env[OPEN_GATE];
    jobCosting._resetVisitGpsLegsCache();
    techId = randomUUID();
    customerId = randomUUID();
    await trx('technicians').insert({ id: techId, name: 'Sample Tech', employment_type: 'w2', employment_status: 'active', pay_rate: '21.00' });
    await trx('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Customer', phone: '+15555550100' });
    await trx('company_financials').insert({ effective_date: '2026-10-01', loaded_labor_rate: 35, drive_cost_per_stop: 6 });
  });
  afterEach(async () => {
    await trx.rollback();
    jobCosting._resetVisitGpsLegsCache();
    for (const [key, value] of Object.entries(OLD)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  afterAll(async () => {
    if (database) await database.destroy();
  });

  it('the migration adds two nullable numeric(8,2) columns to job_costs', async () => {
    const rows = (await trx.raw(
      `select column_name, data_type, numeric_precision, numeric_scale, is_nullable
         from information_schema.columns
        where table_name = 'job_costs' and column_name in ('charged_on_job_minutes', 'charged_drive_minutes')
        order by column_name`,
    )).rows;
    expect(rows).toEqual([
      { column_name: 'charged_drive_minutes', data_type: 'numeric', numeric_precision: 8, numeric_scale: 2, is_nullable: 'YES' },
      { column_name: 'charged_on_job_minutes', data_type: 'numeric', numeric_precision: 8, numeric_scale: 2, is_nullable: 'YES' },
    ]);
  });

  it('gate off, or no card: the minutes stay NULL and the costs are today\'s', async () => {
    await addCard();
    const id = await addVisit();
    await jobCosting.calculateJobCost(id, trx); // GATE_TECH_COST_RATES off
    const row = await jobCost(id);
    expect(row.charged_on_job_minutes).toBeNull();
    expect(row.charged_drive_minutes).toBeNull();
    expect(Number(row.labor_cost)).toBe(35);
    expect(Number(row.drive_cost)).toBe(6);
  });

  it('two completed visits costed with a card: the charged minutes are stored, and a re-cost without a card clears them', async () => {
    gatesOn();
    const card = await addCard();
    const a = await addVisit();
    const b = await addVisit({ actual_start_time: '2026-10-26T15:30:00Z', actual_end_time: '2026-10-26T16:15:00Z' }); // 45 minutes
    await jobCosting.calculateJobCost(a, trx);
    await jobCosting.calculateJobCost(b, trx);
    // No GPS leg yet: the measured defaults, 24 drive minutes a stop.
    expect(Number((await jobCost(a)).charged_on_job_minutes)).toBe(60);
    expect(Number((await jobCost(a)).charged_drive_minutes)).toBe(24);
    expect(Number((await jobCost(b)).charged_on_job_minutes)).toBe(45);
    expect(Number((await jobCost(b)).charged_drive_minutes)).toBe(24);
    // The card no longer applies (the visit is dated before it would take effect): the pair is cleared.
    await trx('technician_cost_cards').where({ id: card.id }).del();
    await jobCosting.calculateJobCost(a, trx);
    const cleared = await jobCost(a);
    expect(cleared.charged_on_job_minutes).toBeNull();
    expect(cleared.charged_drive_minutes).toBeNull();
  });

  it('a card day: paid = the card\'s paid hours, booked = both visits, open at the worked-hour rate', async () => {
    gatesOn();
    await addCard();
    const a = await addVisit();
    const b = await addVisit({ actual_start_time: '2026-10-26T15:30:00Z', actual_end_time: '2026-10-26T16:15:00Z' });
    await jobCosting.calculateJobCost(a, trx);
    await jobCosting.calculateJobCost(b, trx);
    const rate = (await loadVisitRates(trx, techId, '2026-10-26')).laborPerWorkedHourCents;
    const out = await computeOpenTime(trx, { from: '2026-10-26', to: '2026-10-27', today: TODAY });
    expect(out.leftOut).toEqual([]);
    expect(out.days).toEqual([{
      technicianId: techId, day: '2026-10-26', paidMinutes: 600, paidSource: 'card', onJobMinutes: 105, driveMinutes: 48,
      bookedMinutes: 153, openMinutes: 447, overMinutes: 0, openCostCents: Math.round((rate * 447) / 60),
    }]);
    expect(out.totals.bookedShare).toBe(0.255);
  });

  it('a clock day uses time_entry_daily_summary (shift less the unpaid meal); a clocked day with no visit is all open', async () => {
    gatesOn();
    await addCard();
    const a = await addVisit();
    await jobCosting.calculateJobCost(a, trx);
    await trx('time_entry_daily_summary').insert([
      { technician_id: techId, work_date: '2026-10-26', total_shift_minutes: 510, unpaid_meal_minutes: 30 },
      { technician_id: techId, work_date: '2026-10-25', total_shift_minutes: 240, unpaid_meal_minutes: 0 },
    ]);
    const out = await computeOpenTime(trx, { from: '2026-10-25', to: '2026-10-26', today: TODAY });
    const byDay = Object.fromEntries(out.days.map((d) => [d.day, d]));
    expect(byDay['2026-10-26']).toMatchObject({ paidMinutes: 480, paidSource: 'clock', bookedMinutes: 84, openMinutes: 396 });
    expect(byDay['2026-10-25']).toMatchObject({ paidMinutes: 240, paidSource: 'clock', bookedMinutes: 0, openMinutes: 240 });
  });

  it('a visit books the ET day it was worked: scheduled Sunday, arrived Monday evening ET', async () => {
    gatesOn();
    await addCard();
    const a = await addVisit({
      scheduled_date: '2026-10-25',
      arrived_at: '2026-10-27T01:00:00Z', // Monday 21:00 ET, already Tuesday in UTC
      completed_at: '2026-10-27T02:00:00Z',
    });
    await jobCosting.calculateJobCost(a, trx);
    const out = await computeOpenTime(trx, { from: '2026-10-24', to: '2026-10-26', today: TODAY });
    expect(out.leftOut).toEqual([]);
    expect(out.days.map((d) => d.day)).toEqual(['2026-10-26']);
    expect(out.days[0]).toMatchObject({ paidSource: 'card', bookedMinutes: 84 });
  });

  it('a visit costed before the card leaves its day out', async () => {
    await addCard();
    const early = await addVisit({ scheduled_date: '2026-10-24', actual_start_time: '2026-10-24T14:00:00Z', actual_end_time: '2026-10-24T15:00:00Z' });
    await jobCosting.calculateJobCost(early, trx); // gate off: no charged minutes
    gatesOn();
    const out = await computeOpenTime(trx, { from: '2026-10-24', to: '2026-10-26', today: TODAY });
    expect(out.days).toEqual([]);
    expect(out.leftOut).toEqual([{ technicianId: techId, day: '2026-10-24', reason: 'costed_before_card', visits: 1 }]);
  });

  it('a completed visit with no job_costs row at all is also left out', async () => {
    await addCard();
    await addVisit();
    const out = await computeOpenTime(trx, { from: '2026-10-26', to: '2026-10-26', today: TODAY });
    expect(out.leftOut).toEqual([{ technicianId: techId, day: '2026-10-26', reason: 'costed_before_card', visits: 1 }]);
  });

  it('the nightly re-cost gives a visit costed at the defaults the GPS leg the trip link wrote later', async () => {
    gatesOn();
    await addCard();
    const id = await addVisit();
    // Its service record carries the revenue the re-cost keeps (keepRecordedRevenue).
    await trx('service_records').insert({
      scheduled_service_id: id, customer_id: customerId, technician_id: techId, service_date: '2026-10-26',
      service_type: 'Quarterly Pest Control Service', status: 'completed', revenue: 117,
    });
    await jobCosting.calculateJobCost(id, trx);
    expect(Number((await jobCost(id)).charged_drive_minutes)).toBe(24);
    await trx('visit_gps_legs').insert({
      scheduled_service_id: id, leg_group_key: id, technician_id: techId, service_date: '2026-10-26', status: 'matched',
      drive_minutes: 12, drive_miles: 5, shared_stop_count: 1, algorithm_version: 1,
    });
    jobCosting._resetVisitGpsLegsCache();
    const revenueBefore = (await jobCost(id)).revenue;
    const result = await recostNightly({ now: new Date('2026-10-27T05:40:00Z'), conn: trx });
    expect(result).toMatchObject({ recosted: 1, skipped: 0, failed: 0 });
    const after = await jobCost(id);
    expect(Number(after.charged_drive_minutes)).toBe(12);
    expect(Number(after.charged_on_job_minutes)).toBe(60);
    expect(after.revenue).toBe(revenueBefore); // a cost-only run
    expect(Number(after.revenue)).toBe(117);
  });

  it('the nightly re-cost skips a visit with no service record: its ledger revenue is never derived again', async () => {
    gatesOn();
    await addCard();
    const id = await addVisit();
    await jobCosting.calculateJobCost(id, trx);
    const before = await jobCost(id);
    // The visit's price changes after it was costed; a re-cost with no record would book the new price.
    await trx('scheduled_services').where({ id }).update({ estimated_price: 199 });
    await trx('visit_gps_legs').insert({
      scheduled_service_id: id, leg_group_key: id, technician_id: techId, service_date: '2026-10-26', status: 'matched',
      drive_minutes: 12, drive_miles: 5, shared_stop_count: 1, algorithm_version: 1,
    });
    jobCosting._resetVisitGpsLegsCache();
    const result = await recostNightly({ now: new Date('2026-10-27T05:40:00Z'), conn: trx });
    expect(result).toMatchObject({ recosted: 0, skipped: 1, failed: 0 });
    const after = await jobCost(id);
    expect(after.revenue).toBe(before.revenue);
    expect(Number(after.charged_drive_minutes)).toBe(24); // left at its completion-time cost
  });

  it('the nightly re-cost does nothing with either gate off, and recostVisits skips a visit with no card', async () => {
    await addCard();
    const id = await addVisit();
    await jobCosting.calculateJobCost(id, trx);
    process.env[OPEN_GATE] = 'true'; // cost rates off
    expect(await recostNightly({ now: new Date('2026-10-27T05:40:00Z'), conn: trx })).toEqual({ skipped: 'gated' });
    await trx('technician_cost_cards').where({ technician_id: techId }).del();
    expect(await recostVisits(trx, [id])).toEqual({ recosted: 0, skipped: 1, failed: 0 });
  });
});
