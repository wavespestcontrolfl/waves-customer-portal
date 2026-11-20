// Runs with the existing CI PostgreSQL pass; never a production connection.
// Tech Rewards Plan D5-4: the scoreboard's reads (technician row, review asks and credited reviews, finalized gross,
// commission lines) against real Postgres. The tables the reads touch are minimal copies in a private schema; the
// score parts are D5-2's own and are stubbed here (tech-rewards-scores-postgres.test.js covers them). Synthetic data only.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

const mockSchema = `scoreboard_${randomUUID().replaceAll('-', '')}`;
jest.mock('../models/db', () => {
  const knex = require('knex');
  return knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [mockSchema], pool: { min: 0, max: 4 } });
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/tech-rewards-scores', () => ({
  buildSeasonScore: jest.fn(),
  getSettings: jest.fn(),
}));

const WEIGHTS = { onTime: 25, audit: 25, callbacks: 20, truck: 10, ownerRating: 20 };
const CUTS = { top: 90, mid: 80, low: 70 };
const PARTS = { onTime: 95, audit: 90, callbacks: 88, truck: 100, ownerRating: 85 };

(SKIP ? describe.skip : describe)('tech rewards scoreboard reads (live Postgres)', () => {
  let db;
  let scores;
  let service;
  let alpha;
  let beta;
  const NOW = new Date('2026-11-20T15:00:00Z');

  beforeAll(async () => {
    db = require('../models/db');
    scores = require('../services/tech-rewards-scores');
    service = require('../services/tech-rewards-scoreboard');
    await db.raw('CREATE SCHEMA ??', [mockSchema]);
    const s = { createTable: (name, fn) => db.schema.withSchema(mockSchema).createTable(name, fn) };
    await s.createTable('technicians', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('name').notNullable();
      t.date('hire_date');
      t.boolean('active').notNullable().defaultTo(true);
    });
    await s.createTable('payroll_runs', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.text('status').notNullable();
    });
    await s.createTable('payroll_checks', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('run_id');
      t.uuid('technician_id');
      t.text('status').notNullable();
      t.date('week_start').notNullable();
      t.integer('gross_cents').notNullable();
    });
    await s.createTable('payroll_pay_lines', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.text('kind').notNullable();
      t.text('status').notNullable();
      t.text('source_type');
      t.date('earned_week_start').notNullable();
      t.date('covers_to');
      t.integer('amount_cents').notNullable();
    });
    await s.createTable('time_entry_daily_summary', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.date('work_date').notNullable();
      t.decimal('total_shift_minutes', 10, 2);
      t.decimal('unpaid_meal_minutes', 10, 2);
    });
    await s.createTable('review_incentive_payouts', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.text('source').notNullable();
      t.timestamp('earned_at', { useTz: true }).notNullable();
    });
    await s.createTable('review_requests', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.date('service_date');
      t.timestamp('sms_sent_at', { useTz: true });
      t.timestamp('sent_at', { useTz: true });
      t.text('template_key');
    });
    [{ id: alpha }, { id: beta }] = await db('technicians').insert([
      { name: 'Sample Alpha', hire_date: '2025-12-01' }, { name: 'Sample Beta', hire_date: '2024-01-15' },
    ]).returning('id');
  });

  afterAll(async () => {
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  beforeEach(async () => {
    for (const table of ['payroll_checks', 'payroll_runs', 'payroll_pay_lines', 'review_incentive_payouts', 'review_requests', 'time_entry_daily_summary']) await db(table).del();
    scores.buildSeasonScore.mockReset().mockResolvedValue({
      complete: true, year: 2026, parts: PARTS, score: 91.5, rateBps: 400, settings: { version: 0, weights: WEIGHTS, cutLines: CUTS },
    });
    scores.getSettings.mockReset().mockResolvedValue({ version: 0, weights: WEIGHTS, cutLines: CUTS });
  });

  async function seed() {
    const [run, voided] = (await db('payroll_runs').insert([{ status: 'finalized' }, { status: 'voided' }]).returning('id')).map((r) => r.id);
    await db('payroll_checks').insert([
      { run_id: run, technician_id: alpha, status: 'finalized', week_start: '2026-03-02', gross_cents: 100000 },
      { run_id: run, technician_id: alpha, status: 'finalized', week_start: '2026-08-31', gross_cents: 50000 },
      { run_id: run, technician_id: alpha, status: 'finalized', week_start: '2026-09-07', gross_cents: 70000 }, // after the season
      { run_id: run, technician_id: alpha, status: 'finalized', week_start: '2026-02-23', gross_cents: 10000 }, // before the season, inside the prior 12 months
      { run_id: voided, technician_id: alpha, status: 'finalized', week_start: '2026-04-06', gross_cents: 999999 }, // voided run
      { run_id: run, technician_id: alpha, status: 'voided', week_start: '2026-04-13', gross_cents: 888888 }, // voided check
      { run_id: run, technician_id: beta, status: 'finalized', week_start: '2026-04-06', gross_cents: 777777 }, // someone else
    ]);
    await db('time_entry_daily_summary').insert([
      // the Aug 31 week: Mon 8 h inside the season, Tue-Wed 16 h after it (Tuesday's unpaid meal leaves 8 h paid)
      { technician_id: alpha, work_date: '2026-08-31', total_shift_minutes: 480, unpaid_meal_minutes: 0 },
      { technician_id: alpha, work_date: '2026-09-01', total_shift_minutes: 510, unpaid_meal_minutes: 30 },
      { technician_id: alpha, work_date: '2026-09-02', total_shift_minutes: 480, unpaid_meal_minutes: 0 },
      // the Feb 23 week (ends Mar 1): every hour before the season
      { technician_id: alpha, work_date: '2026-02-24', total_shift_minutes: 480, unpaid_meal_minutes: 0 },
      { technician_id: alpha, work_date: '2026-02-25', total_shift_minutes: 480, unpaid_meal_minutes: 0 },
      { technician_id: beta, work_date: '2026-09-01', total_shift_minutes: 480, unpaid_meal_minutes: 0 },
    ]);
    await db('payroll_pay_lines').insert([
      { technician_id: alpha, kind: 'commission', status: 'paid', earned_week_start: '2026-04-06', amount_cents: 20000 },
      { technician_id: alpha, kind: 'commission', status: 'open', earned_week_start: '2026-11-09', amount_cents: 10000 },
      { technician_id: alpha, kind: 'commission', status: 'voided', earned_week_start: '2026-05-04', amount_cents: 5000 },
      { technician_id: alpha, kind: 'commission', status: 'paid', earned_week_start: '2025-12-29', amount_cents: 4000 }, // a hand-made line of last year's week
      { technician_id: alpha, kind: 'commission', source_type: 'commission_payment', status: 'paid', earned_week_start: '2025-12-29', covers_to: '2026-01-01', amount_cents: 2500 }, // paid Jan 1: this year, in the week of Dec 29
      { technician_id: alpha, kind: 'commission', source_type: 'commission_payment', status: 'open', earned_week_start: '2026-12-14', covers_to: '2026-12-15', amount_cents: 7000 }, // dated after today
      { technician_id: alpha, kind: 'commission', source_type: 'commission_payment', status: 'paid', earned_week_start: '2026-01-05', covers_to: '2025-12-31', amount_cents: 6000 }, // ledger line: the payment day (last year) decides, not the pay week
      { technician_id: alpha, kind: 'commission', status: 'paid', earned_week_start: '2026-07-06', covers_to: '2026-12-20', amount_cents: 1100 }, // hand-made line: its own pay week decides, though it covers a later span
      { technician_id: alpha, kind: 'review_bonus', status: 'paid', earned_week_start: '2026-04-06', amount_cents: 1500 }, // not commission
      { technician_id: beta, kind: 'commission', status: 'paid', earned_week_start: '2026-04-06', amount_cents: 33333 },
    ]);
    await db('review_incentive_payouts').insert([
      { technician_id: alpha, source: 'google_review', earned_at: '2026-04-10T15:00:00Z' },
      { technician_id: alpha, source: 'google_review', earned_at: '2026-08-31T23:30:00Z' }, // Aug 31 ET
      { technician_id: alpha, source: 'google_review', earned_at: '2026-09-01T03:30:00Z' }, // Aug 31 11:30 PM ET: inside
      { technician_id: alpha, source: 'google_review', earned_at: '2026-09-01T05:00:00Z' }, // Sep 1 1 AM ET: outside
      { technician_id: alpha, source: 'review_request', earned_at: '2026-05-10T15:00:00Z' }, // legacy source
      { technician_id: beta, source: 'google_review', earned_at: '2026-05-10T15:00:00Z' },
    ]);
    await db('review_requests').insert([
      { technician_id: alpha, service_date: '2026-04-10', sms_sent_at: '2026-04-10T16:00:00Z' },
      { technician_id: alpha, service_date: '2026-05-10', sent_at: '2026-05-10T16:00:00Z' },
      { technician_id: alpha, service_date: '2026-06-10' }, // never sent
      { technician_id: alpha, service_date: '2026-09-10', sms_sent_at: '2026-09-10T16:00:00Z' }, // after the season
      { technician_id: alpha, service_date: '2026-08-31', sms_sent_at: '2026-09-01T15:00:00Z' }, // visit in the season, ask sent after it
      { technician_id: alpha, service_date: '2026-08-30', sms_sent_at: '2026-09-01T03:30:00Z' }, // sent Aug 31 11:30 PM ET: inside
      { technician_id: alpha, service_date: '2026-07-01', sms_sent_at: '2026-07-01T16:00:00Z', template_key: 'resolution_check' }, // a no-link check-in is not an ask
      { technician_id: beta, service_date: '2026-04-10', sms_sent_at: '2026-04-10T16:00:00Z' },
    ]);
  }

  test('sums only the technician own finalized figures for the season it shows', async () => {
    await seed();
    const board = await service.getScoreboard(alpha, { now: NOW });
    expect(board.technician).toEqual({ id: alpha, name: 'Sample Alpha' });
    expect(board.season).toMatchObject({ year: 2026, status: 'final' });
    expect(scores.buildSeasonScore).toHaveBeenCalledWith(alpha, 2026, { start: '2026-03-01', end: '2026-08-31' }, expect.anything());
    // the Mar 2 week in full; the Aug 31 week (Aug 31 - Sep 6) by paid minutes: 480 of 480 + 480 + 480 (Tuesday's 510 less a 30 minute unpaid meal) = 1440 -> 50000 x 480 / 1440; the Feb 23 week (ends Mar 1) had no hours in the season
    expect(board.seasonBonus.grossCents).toBe(100000 + Math.round((50000 * 480) / 1440));
    expect(board.reviews).toMatchObject({ count: 3, asks: 3, rateBps: 10000 });
    expect(board.commission).toEqual({ year: 2026, yearToDateCents: 33600, paidCents: 23600, pendingCents: 10000 });
    // hired 2025-12-01: the 1-year bonus is due 2026-12-01 from the pay of 2025-12-01 .. today: 100000+50000+70000+10000
    expect(board.stayBonus).toMatchObject({ dueDate: '2026-12-01', years: 1, estimateCents: Math.round(230000 * 0.02) });
  });

  test('a running season is cut at today: the score window, the settings lookup and the counts', async () => {
    await seed();
    scores.buildSeasonScore.mockResolvedValue({ complete: false, year: 2026, parts: { ...PARTS, audit: null }, missing: ['audit'] });
    const board = await service.getScoreboard(alpha, { now: new Date('2026-06-15T15:00:00Z') });
    expect(board.season).toMatchObject({ year: 2026, status: 'running' });
    expect(scores.buildSeasonScore).toHaveBeenCalledWith(alpha, 2026, { start: '2026-03-01', end: '2026-06-15' }, expect.anything());
    expect(scores.getSettings).toHaveBeenCalledWith('2026-06-15', expect.anything());
    expect(board.seasonBonus.grossCents).toBe(100000); // the Aug 31 week has not happened yet; the Feb 23 week's hours were all before Mar 1
    expect(board.reviews).toMatchObject({ count: 1, asks: 2 }); // the Apr 10 review; asks of Apr 10 and May 10
  });

  test('a stay bonus whose 12 months of pay have not begun keeps its date and has no amount', async () => {
    await seed();
    const [gamma] = await db('technicians').insert({ name: 'Sample Gamma', hire_date: '2025-04-01' }).returning('id');
    const board = await service.getScoreboard(gamma.id, { now: NOW });
    expect(board.stayBonus).toMatchObject({ dueDate: '2028-04-01', years: 3, estimateCents: null, earningsStart: '2027-04-01' });
  });

  test('an edge week with no daily summaries falls back to days / 7', async () => {
    await seed();
    await db('time_entry_daily_summary').where({ technician_id: alpha }).del();
    const board = await service.getScoreboard(alpha, { now: NOW });
    expect(board.seasonBonus.grossCents).toBe(100000 + 7143 + 1429);
  });

  test('another technician is never mixed in', async () => {
    await seed();
    const board = await service.getScoreboard(beta, { now: NOW });
    expect(board.technician.name).toBe('Sample Beta');
    expect(board.seasonBonus.grossCents).toBe(777777);
    expect(board.reviews).toMatchObject({ count: 1, asks: 1 });
    expect(board.commission.paidCents).toBe(33333);
  });

  test('reads in one REPEATABLE READ, read-only snapshot', async () => {
    await seed();
    scores.buildSeasonScore.mockImplementation(async (id, year, season, trx) => {
      const level = (await trx.raw('SHOW transaction_isolation')).rows[0].transaction_isolation;
      const readOnly = (await trx.raw('SHOW transaction_read_only')).rows[0].transaction_read_only;
      expect([level, readOnly]).toEqual(['repeatable read', 'on']);
      return { complete: true, year, parts: PARTS, score: 91.5, rateBps: 400, settings: { version: 0, weights: WEIGHTS, cutLines: CUTS } };
    });
    await service.getScoreboard(alpha, { now: NOW });
    expect(scores.buildSeasonScore).toHaveBeenCalledTimes(1);
  });

  test('an unknown technician is 404 and a malformed id is 400', async () => {
    await expect(service.getScoreboard(randomUUID(), { now: NOW })).rejects.toMatchObject({ status: 404 });
    await expect(service.getScoreboard('nope', { now: NOW })).rejects.toMatchObject({ status: 400 });
  });

  test('lists active technicians for the preview picker, names and ids only', async () => {
    const gone = (await db('technicians').insert({ name: 'Sample Gone', active: false }).returning('id'))[0].id;
    const list = await service.listTechnicians();
    expect(list.map((t) => t.name)).toEqual(expect.arrayContaining(['Sample Alpha', 'Sample Beta']));
    expect(list.map((t) => t.id)).not.toContain(gone);
    expect(Object.keys(list[0]).sort()).toEqual(['id', 'name']);
  });
});
