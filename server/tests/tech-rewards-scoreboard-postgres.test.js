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
jest.mock('../services/tech-rewards-scores', () => {
  class TechRewardsScoresError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }
  return { TechRewardsScoresError, buildSeasonScore: jest.fn(), getSettings: jest.fn() };
});

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
      // who gets a Tech Rewards pay line (tech-rewards-pay-lines.js recipients)
      t.text('employment_type');
      t.text('role');
      t.text('employment_status');
      t.boolean('field_dispatchable');
    });
    await s.createTable('payroll_runs', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.date('week_start').notNullable();
      t.date('pay_date').notNullable();
      t.text('status').notNullable();
    });
    await s.createTable('payroll_checks', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('run_id');
      t.uuid('technician_id');
      t.text('status').notNullable();
      t.date('week_start').notNullable();
      t.integer('gross_cents').notNullable();
      t.integer('regular_pay_cents').notNullable().defaultTo(0);
      t.integer('overtime_pay_cents').notNullable().defaultTo(0);
      t.decimal('overtime_minutes', 10, 2).notNullable().defaultTo(0);
      t.integer('pto_pay_cents');
      t.integer('holiday_pay_cents');
      t.integer('tech_rewards_cents');
      t.jsonb('calc_snapshot').notNullable().defaultTo('{}');
    });
    await s.createTable('payroll_time_off', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.date('work_date').notNullable();
      t.text('kind').notNullable();
      t.decimal('minutes', 10, 2).notNullable();
    });
    await s.createTable('payroll_pay_lines', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('technician_id');
      t.text('kind').notNullable();
      t.text('status').notNullable();
      t.text('source_type');
      t.text('source_id');
      t.uuid('check_id');
      t.date('earned_week_start').notNullable();
      t.date('covers_from');
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
    await s.createTable('messaging_audit_log', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.uuid('customer_id');
      t.text('entry_point');
      t.jsonb('metadata');
      t.timestamp('sent_at', { useTz: true });
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
      t.uuid('customer_id');
      t.timestamp('followup_delivered_at', { useTz: true });
      t.date('service_date');
      t.timestamp('sms_sent_at', { useTz: true });
      t.timestamp('sent_at', { useTz: true });
      t.text('template_key');
    });
    [{ id: alpha }, { id: beta }] = await db('technicians').insert([
      { name: 'Sample Alpha', hire_date: '2025-12-01' }, { name: 'Sample Beta', hire_date: '2024-01-15' },
    ]).returning('id');
  }, 60000);

  afterAll(async () => {
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  beforeEach(async () => {
    for (const table of ['payroll_checks', 'payroll_runs', 'payroll_pay_lines', 'review_incentive_payouts', 'review_requests', 'time_entry_daily_summary', 'messaging_audit_log', 'payroll_time_off']) await db(table).del();
    scores.buildSeasonScore.mockReset().mockResolvedValue({
      complete: true, year: 2026, parts: PARTS, score: 91.5, rateBps: 400, settings: { version: 0, weights: WEIGHTS, cutLines: CUTS },
    });
    scores.getSettings.mockReset().mockResolvedValue({ version: 0, weights: WEIGHTS, cutLines: CUTS });
  });

  // a plain check: all of its gross is regular pay unless the row says otherwise
  const insertChecks = (rows) => db('payroll_checks').insert(rows.map((row) => ({ regular_pay_cents: row.gross_cents, ...row })));

  async function seed() {
    const [run, voided] = (await db('payroll_runs').insert([{ status: 'finalized', week_start: '2026-10-26', pay_date: '2026-11-06' }, { status: 'voided', week_start: '2026-11-02', pay_date: '2026-11-13' }]).returning('id')).map((r) => r.id);
    await insertChecks([
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
    expect(board.commission).toEqual({ year: 2026, yearToDateCents: 33600, paidCents: 23600, unpaidCents: 10000, recordedThrough: { weekEnd: '2026-12-20' } }); // the newest ledger line is dated Dec 14
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

  test('a stay bonus milestone a pay run has settled is not the next one, whatever the hire date on file says now', async () => {
    await seed();
    // Alpha's hire date on file puts the 1 year anniversary on Dec 1, 2026, ahead of today. An open line and a row that is not
    // the pay run's own settle nothing.
    const line = { technician_id: alpha, kind: 'stay_bonus', source_type: 'tech_rewards', earned_week_start: '2026-11-02', amount_cents: 5280 };
    await db('payroll_pay_lines').insert([
      { ...line, status: 'open', source_id: `stay_bonus:${alpha}:1` },
      { ...line, status: 'paid', source_id: `stay_bonus:${beta}:1` },
    ]);
    expect((await service.getScoreboard(alpha, { now: NOW })).stayBonus).toMatchObject({ dueDate: '2026-12-01', years: 1 });
    // the pay run paid the 1 year bonus (from an earlier hire date on file): the board shows the 3 year one
    await db('payroll_pay_lines').where({ technician_id: alpha, status: 'open' }).update({ status: 'paid' });
    expect((await service.getScoreboard(alpha, { now: NOW })).stayBonus)
      .toMatchObject({ dueDate: '2028-12-01', years: 3, rateBps: 400, estimateCents: null, earningsStart: '2027-12-01' });
  });

  test('catch-up pay: lines paid in a later week count on the day they were earned, wages by work week', async () => {
    await seed();
    const [sept] = await db('payroll_checks').where({ technician_id: alpha, week_start: '2026-09-07' }).select('id');
    await db('payroll_checks').where({ id: sept.id }).update({ regular_pay_cents: 58500 }); // 70000 less the 11500 of lines
    const [payout] = await db('review_incentive_payouts').where({ technician_id: alpha, source: 'google_review' }).orderBy('earned_at').limit(1).select('id');
    await db('payroll_pay_lines').insert([
      // the Sept 7 check's 70000 gross holds 11500 of lines; its wages (58500) are outside the season
      { technician_id: alpha, check_id: sept.id, kind: 'commission', source_type: 'commission_payment', status: 'paid', earned_week_start: '2026-09-07', covers_to: '2026-05-10', amount_cents: 8000 }, // earned May 10
      { technician_id: alpha, check_id: sept.id, kind: 'review_bonus', source_type: 'review_incentive_payout', source_id: payout.id, status: 'paid', earned_week_start: '2026-09-07', amount_cents: 1500 }, // review credited Apr 10
      { technician_id: alpha, check_id: sept.id, kind: 'commission', status: 'paid', earned_week_start: '2026-09-07', amount_cents: 2000 }, // hand-made, earned in its own September week
    ]);
    const board = await service.getScoreboard(alpha, { now: NOW });
    expect(board.seasonBonus.grossCents).toBe(100000 + Math.round((50000 * 480) / 1440) + 8000 + 1500);
    expect(board.commission).toMatchObject({ paidCents: 23600 + 8000 + 2000 });
    // the stay window holds the same wages (218500) and all three lines (11500) once each
    expect(board.stayBonus.estimateCents).toBe(Math.round(230000 * 0.02));
  });

  test('a closed season counts the checks for the pay weeks before the bonus\'s own run, and no check for a later pay week', async () => {
    const [gam] = await db('technicians').insert({ name: 'Sample Gamma', hire_date: '2024-01-15' }).returning('id');
    const [run] = await db('payroll_runs').insert({ status: 'finalized', week_start: '2026-09-14', pay_date: '2026-09-25' }).returning('id');
    const [, cut, later] = await insertChecks([
      { run_id: run.id, technician_id: gam.id, status: 'finalized', week_start: '2026-05-04', gross_cents: 100000 },
      // the week of Sep 7: the last pay week counted for 2026 (its run is dated Sep 18, before the bonus's pay date, Sep 25)
      { run_id: run.id, technician_id: gam.id, status: 'finalized', week_start: '2026-09-07', gross_cents: 8000, regular_pay_cents: 0 },
      // the week of Sep 14: the bonus's own pay week, and every week after it, is never counted
      { run_id: run.id, technician_id: gam.id, status: 'finalized', week_start: '2026-09-14', gross_cents: 6000, regular_pay_cents: 0 },
    ]).returning('id');
    await db('payroll_pay_lines').insert([
      { technician_id: gam.id, check_id: cut.id, kind: 'commission', source_type: 'commission_payment', status: 'paid', earned_week_start: '2026-09-07', covers_to: '2026-05-10', amount_cents: 8000 }, // earned May 10
      { technician_id: gam.id, check_id: later.id, kind: 'commission', source_type: 'commission_payment', status: 'paid', earned_week_start: '2026-09-14', covers_to: '2026-05-11', amount_cents: 6000 }, // earned May 11, paid a week too late
    ]);
    const board = await service.getScoreboard(gam.id, { now: NOW });
    expect(board.seasonBonus.grossCents).toBe(100000 + 8000);
  });

  test('a season bonus shows as paid only for the pay run\'s own line on a finalized check of a finalized run', async () => {
    await seed();
    const LATER = new Date('2027-11-20T15:00:00Z'); // the 2027 season is closed
    scores.buildSeasonScore.mockImplementation(async (id, year) => ({ complete: true, year, parts: PARTS, score: 91.5, rateBps: 400, settings: { version: 0, weights: WEIGHTS, cutLines: CUTS } }));
    const key = (year) => ({ technician_id: alpha, kind: 'season_bonus', source_type: 'tech_rewards', source_id: `season_bonus:${alpha}:${year}`, earned_week_start: `${year}-09-13` });
    await db('payroll_pay_lines').insert([
      { ...key(2027), status: 'open', amount_cents: 41000 }, // on a draft run: not paid yet
      // marked paid with the key of the 2026 season: no season before 2027 has a bonus, so it is not the pay run's line, and no check holds it
      { ...key(2026), status: 'paid', amount_cents: 39000 },
      { technician_id: alpha, kind: 'season_bonus', status: 'paid', earned_week_start: '2027-09-13', amount_cents: 12300 }, // hand-made: no source key
    ]);
    const board = async (now) => (await service.getScoreboard(alpha, { now })).seasonBonus;
    // the 2026 season: the row keyed for it never shows as paid
    expect(await board(NOW)).toMatchObject({ estimate: true });
    expect(await board(NOW)).not.toHaveProperty('paidCents');
    // the 2027 season: an open line is not paid
    const before = await board(LATER);
    expect(before).toMatchObject({ estimate: true });
    expect(before).not.toHaveProperty('paidCents');
    const own = () => db('payroll_pay_lines').where({ source_id: `season_bonus:${alpha}:2027` });
    // marked paid with no check
    await own().update({ status: 'paid' });
    expect(await board(LATER)).not.toHaveProperty('paidCents');
    // on a check that is not final, of a run that is not final
    const [run] = await db('payroll_runs').insert({ status: 'draft', week_start: '2027-09-13', pay_date: '2027-09-24' }).returning('id');
    const [check] = await insertChecks([{ run_id: run.id, technician_id: alpha, status: 'draft', week_start: '2027-09-13', gross_cents: 41000 }]).returning('id');
    await own().update({ check_id: check.id });
    expect(await board(LATER)).not.toHaveProperty('paidCents');
    await db('payroll_checks').where({ id: check.id }).update({ status: 'finalized' });
    expect(await board(LATER)).not.toHaveProperty('paidCents'); // the run is still a draft
    await db('payroll_runs').where({ id: run.id }).update({ status: 'voided' });
    expect(await board(LATER)).not.toHaveProperty('paidCents');
    // the pay run's own line, on a finalized check of a finalized run: paid, and no estimate beside it
    await db('payroll_runs').where({ id: run.id }).update({ status: 'finalized' });
    expect(await board(LATER)).toEqual({ grossCents: before.grossCents, estimate: false, estimateCents: null, paidCents: 41000 });
    // the 2026 row on that same finalized check is still not the pay run's line
    await db('payroll_pay_lines').where({ source_id: `season_bonus:${alpha}:2026` }).update({ check_id: check.id });
    expect(await board(NOW)).not.toHaveProperty('paidCents');
  });

  test('paid time off on Aug 31 and a catch-up overtime premium earned in May are dated by their own records', async () => {
    const [eps] = await db('technicians').insert({ name: 'Sample Epsilon', hire_date: '2024-01-15' }).returning('id');
    const [run] = await db('payroll_runs').insert({ status: 'finalized', week_start: '2026-09-07', pay_date: '2026-09-18' }).returning('id');
    await insertChecks([
      // the Aug 31 week: 30000 of wages (a third worked on Aug 31) and 10000 of PTO taken Aug 31 and Sep 1
      { run_id: run.id, technician_id: eps.id, status: 'finalized', week_start: '2026-08-31', gross_cents: 40000, regular_pay_cents: 30000, pto_pay_cents: 10000 },
      // paid in September: 7000 of wages (outside) and a 3000 overtime premium earned in two May weeks
      { run_id: run.id, technician_id: eps.id, status: 'finalized', week_start: '2026-09-07', gross_cents: 10000, regular_pay_cents: 7000,
        calc_snapshot: { lineOvertimeWeeks: [{ weekStart: '2026-05-04', premiumCents: 2000 }, { weekStart: '2026-05-11', premiumCents: 1000 }] } },
    ]);
    await db('time_entry_daily_summary').insert([
      { technician_id: eps.id, work_date: '2026-08-31', total_shift_minutes: 480, unpaid_meal_minutes: 0 },
      { technician_id: eps.id, work_date: '2026-09-01', total_shift_minutes: 480, unpaid_meal_minutes: 0 },
      { technician_id: eps.id, work_date: '2026-09-02', total_shift_minutes: 480, unpaid_meal_minutes: 0 },
    ]);
    await db('payroll_time_off').insert([
      { technician_id: eps.id, work_date: '2026-08-31', kind: 'pto', minutes: 480 },
      { technician_id: eps.id, work_date: '2026-09-01', kind: 'pto', minutes: 480 },
    ]);
    const board = await service.getScoreboard(eps.id, { now: NOW });
    expect(board.seasonBonus.grossCents).toBe(10000 + 5000 + 3000);
  });

  test('review asks count every delivered ask by its send day: a follow-up counts once even when stamped twice', async () => {
    await seed();
    const [c1, c2, c3, c4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const rows = await db('review_requests').insert([
      { technician_id: alpha, customer_id: c1, service_date: '2026-04-11', sms_sent_at: '2026-04-11T16:00:00Z', followup_delivered_at: '2026-06-05T16:00:00Z' }, // stamp only
      { technician_id: alpha, customer_id: c2, service_date: '2026-05-12', sms_sent_at: '2026-05-12T16:00:00Z' }, // audit log only
      { technician_id: alpha, customer_id: c3, service_date: '2026-06-01', sms_sent_at: '2026-06-01T16:00:00Z', followup_delivered_at: '2026-06-25T16:00:00Z' }, // both
      { technician_id: alpha, customer_id: c4, service_date: '2026-08-20', sms_sent_at: '2026-08-20T16:00:00Z' }, // follow-up after the season
    ]).returning(['id', 'customer_id']);
    const idOf = (customer) => rows.find((r) => r.customer_id === customer).id;
    await db('messaging_audit_log').insert([
      { customer_id: c2, entry_point: 'review_request_followup', metadata: { review_request_id: idOf(c2) }, sent_at: '2026-06-20T16:00:00Z' },
      { customer_id: c3, entry_point: 'review_request_followup', metadata: { review_request_id: idOf(c3) }, sent_at: '2026-06-25T16:00:05Z' },
      { customer_id: c4, entry_point: 'review_request_followup', metadata: { review_request_id: idOf(c4) }, sent_at: '2026-09-02T16:00:00Z' },
      { customer_id: c1, entry_point: 'sms_other', metadata: { review_request_id: idOf(c1) }, sent_at: '2026-06-06T16:00:00Z' }, // not a follow-up
    ]);
    const board = await service.getScoreboard(alpha, { now: NOW });
    // the 3 seeded asks + (initial + follow-up) for c1, c2, c3 + the initial for c4 (its follow-up is after the season)
    expect(board.reviews.asks).toBe(3 + 6 + 1);
  });

  test('no score settings in force: the score and bonus are unavailable, the rest still shows', async () => {
    await seed();
    const noSettings = new scores.TechRewardsScoresError('NO_SETTINGS_IN_FORCE', 'none in force');
    scores.buildSeasonScore.mockRejectedValue(noSettings);
    let board = await service.getScoreboard(alpha, { now: NOW });
    expect(board.score).toMatchObject({ unavailable: 'no_settings', complete: false, value: null, band: null, parts: {} });
    expect(board.seasonBonus).toMatchObject({ estimateCents: null, reason: 'no_settings' });
    expect(board.reviews.asks).toBe(3);
    expect(board.commission.paidCents).toBe(23600);
    expect(board.stayBonus).toMatchObject({ dueDate: '2026-12-01' });
    // the same when the parts are incomplete and the weights lookup is what finds no settings
    scores.buildSeasonScore.mockResolvedValue({ complete: false, year: 2026, parts: { ...PARTS, audit: null }, missing: ['audit'] });
    scores.getSettings.mockRejectedValue(noSettings);
    board = await service.getScoreboard(alpha, { now: NOW });
    expect(board.score.unavailable).toBe('no_settings');
    // any other failure is still a failure
    scores.buildSeasonScore.mockRejectedValue(new scores.TechRewardsScoresError('MALFORMED_SETTINGS', 'bad'));
    await expect(service.getScoreboard(alpha, { now: NOW })).rejects.toMatchObject({ code: 'MALFORMED_SETTINGS' });
  });

  test('the stay bonus window ends the day before the anniversary and prorates a check that spans that day', async () => {
    await seed();
    const fieldTech = { employment_type: 'w2', role: 'technician', employment_status: 'active', field_dispatchable: true };
    const [delta, office] = await db('technicians').insert([
      { name: 'Sample Delta', hire_date: '2025-12-01', ...fieldTech },
      { name: 'Sample Office', hire_date: '2025-12-01', ...fieldTech, role: 'admin' }, // payroll writes an office account no line
    ]).returning('id');
    const [run] = await db('payroll_runs').insert({ status: 'finalized', week_start: '2026-11-30', pay_date: '2026-12-11' }).returning('id');
    await insertChecks([{ run_id: run.id, technician_id: delta.id, status: 'finalized', week_start: '2026-11-30', gross_cents: 70000 }]);
    await db('time_entry_daily_summary').insert([
      { technician_id: delta.id, work_date: '2026-11-30', total_shift_minutes: 480, unpaid_meal_minutes: 0 }, // in the window
      { technician_id: delta.id, work_date: '2026-12-01', total_shift_minutes: 480, unpaid_meal_minutes: 0 }, // on the anniversary: not in it
    ]);
    const board = await service.getScoreboard(delta.id, { now: new Date('2026-12-01T15:00:00Z') });
    expect(board.stayBonus).toMatchObject({ dueDate: '2026-12-01', earningsStart: '2025-12-01', estimateCents: Math.round(35000 * 0.02) });
    // the anniversary day is the first day a pay run can carry the bonus, so payroll answers for it: an office account sees
    // the milestone the day before (it is ahead, and shows for everyone) and the next one from the day itself
    expect((await service.getScoreboard(office.id, { now: new Date('2026-11-30T15:00:00Z') })).stayBonus).toMatchObject({ dueDate: '2026-12-01', years: 1 });
    expect((await service.getScoreboard(office.id, { now: new Date('2026-12-01T15:00:00Z') })).stayBonus).toMatchObject({ dueDate: '2028-12-01', years: 3 });
  });

  test('after the anniversary the stay bonus stays on the board until it is paid, worked out from the 12 months that ended', async () => {
    await seed();
    const fieldTech = { employment_type: 'w2', role: 'technician', employment_status: 'active', field_dispatchable: true };
    const [delta, office] = await db('technicians').insert([
      { name: 'Sample Delta', hire_date: '2025-12-01', ...fieldTech },
      { name: 'Sample Office', hire_date: '2025-12-01', ...fieldTech, role: 'admin' }, // payroll writes an office account no line
    ]).returning('id');
    const [inside, after] = await db('payroll_runs').insert([
      { status: 'finalized', week_start: '2026-11-16', pay_date: '2026-11-27' },
      { status: 'finalized', week_start: '2026-12-07', pay_date: '2026-12-18' },
    ]).returning('id');
    await insertChecks([
      { run_id: inside.id, technician_id: delta.id, status: 'finalized', week_start: '2026-11-16', gross_cents: 70000 }, // a week of the 12 months
      { run_id: after.id, technician_id: delta.id, status: 'finalized', week_start: '2026-12-07', gross_cents: 90000 }, // after them: never counts
    ]);
    const today = new Date('2026-12-20T15:00:00Z');
    expect((await service.getScoreboard(delta.id, { now: today })).stayBonus)
      .toMatchObject({ dueDate: '2026-12-01', years: 1, earningsStart: '2025-12-01', earningsEnd: '2026-11-30', estimateCents: Math.round(70000 * 0.02) });
    // the 60 days are over (Jan 31), or payroll would write this account no line: the next milestone ahead, as before
    expect((await service.getScoreboard(delta.id, { now: new Date('2027-01-31T15:00:00Z') })).stayBonus).toMatchObject({ dueDate: '2028-12-01', years: 3 });
    expect((await service.getScoreboard(office.id, { now: today })).stayBonus).toMatchObject({ dueDate: '2028-12-01', years: 3 });
    // payroll pays it: the board shows the 3 year bonus
    await db('payroll_pay_lines').insert({
      technician_id: delta.id, kind: 'stay_bonus', source_type: 'tech_rewards', source_id: `stay_bonus:${delta.id}:1`, status: 'paid', earned_week_start: '2026-12-07', amount_cents: 1400,
    });
    expect((await service.getScoreboard(delta.id, { now: today })).stayBonus).toMatchObject({ dueDate: '2028-12-01', years: 3 });
  });

  // PostgreSQL prints a date BC with no era in YYYY-MM-DD, and holds years past 9999: payroll reads neither, so the board does not
  test.each(['2025-12-01 BC', '20251-12-01', '0099-12-01', 'infinity'])('a hire date on file that payroll cannot read (%s) is none on the board', async (hireDate) => {
    await seed();
    const [odd] = await db('technicians').insert({ name: 'Sample Odd', hire_date: hireDate }).returning('id');
    const board = await service.getScoreboard(odd.id, { now: new Date('2026-12-20T15:00:00Z') });
    expect(board.stayBonus).toBeNull();
    expect(board.multiplier).toEqual({ reason: 'no_hire_date' });
  });

  test('commission is recorded through the end of the pay week of the newest ledger line, never a run date', async () => {
    // pay runs exist for later weeks, but the ledger lines prove a sync only through the week of the newest one
    await db('payroll_runs').insert([
      { status: 'finalized', week_start: '2026-11-02', pay_date: '2026-11-13' },
      { status: 'draft', week_start: '2026-11-16', pay_date: '2026-11-27' },
    ]);
    await db('payroll_pay_lines').insert([
      { technician_id: alpha, kind: 'commission', source_type: 'commission_payment', status: 'paid', earned_week_start: '2026-11-02', covers_to: '2026-11-05', amount_cents: 4000 },
      { technician_id: alpha, kind: 'commission', source_type: 'commission_payment', status: 'paid', earned_week_start: '2026-10-05', covers_to: '2026-10-08', amount_cents: 900 },
      { technician_id: alpha, kind: 'commission', source_type: 'commission_payment', status: 'voided', earned_week_start: '2026-11-16', covers_to: '2026-11-17', amount_cents: 500 }, // a voided line proves nothing
      { technician_id: alpha, kind: 'commission', status: 'paid', earned_week_start: '2026-11-16', amount_cents: 700 }, // hand-made: not ledger evidence
      { technician_id: beta, kind: 'commission', source_type: 'commission_payment', status: 'paid', earned_week_start: '2026-11-09', covers_to: '2026-11-10', amount_cents: 100 },
    ]);
    const board = await service.getScoreboard(alpha, { now: NOW });
    expect(board.commission.recordedThrough).toEqual({ weekEnd: '2026-11-08' });
    expect(board.commission.paidCents).toBe(4000 + 900 + 700);
  });

  test('no ledger line for the technician: no cutoff date, even with pay runs on file', async () => {
    await db('payroll_runs').insert({ status: 'finalized', week_start: '2026-11-02', pay_date: '2026-11-13' });
    await db('payroll_pay_lines').insert({ technician_id: alpha, kind: 'commission', status: 'paid', earned_week_start: '2026-11-02', amount_cents: 700 }); // hand-made only
    const board = await service.getScoreboard(alpha, { now: NOW });
    expect(board.commission.recordedThrough).toBeNull();
  });

  test('a hand-made line with only a pay week counts that week in-window days / 7 in the bonus base', async () => {
    const [zed] = await db('technicians').insert({ name: 'Sample Zed', hire_date: '2024-01-15' }).returning('id');
    const [run] = await db('payroll_runs').insert({ status: 'finalized', week_start: '2026-09-07', pay_date: '2026-09-18' }).returning('id');
    const [check] = await insertChecks([{ run_id: run.id, technician_id: zed.id, status: 'finalized', week_start: '2026-09-07', gross_cents: 7000, regular_pay_cents: 0 }]).returning('id');
    await db('payroll_pay_lines').insert([
      { technician_id: zed.id, check_id: check.id, kind: 'commission', status: 'paid', earned_week_start: '2026-08-31', amount_cents: 7000 }, // week-only: Aug 31 is 1 of 7 days
    ]);
    const board = await service.getScoreboard(zed.id, { now: NOW });
    expect(board.seasonBonus.grossCents).toBe(1000);
  });

  test('a health allowance covering August assigned to a September pay week counts in the season base', async () => {
    const [yan] = await db('technicians').insert({ name: 'Sample Yan', hire_date: '2024-01-15' }).returning('id');
    const [run] = await db('payroll_runs').insert({ status: 'finalized', week_start: '2026-09-07', pay_date: '2026-09-18' }).returning('id');
    const [check] = await insertChecks([{ run_id: run.id, technician_id: yan.id, status: 'finalized', week_start: '2026-09-07', gross_cents: 6000, regular_pay_cents: 0 }]).returning('id');
    await db('payroll_pay_lines').insert({ technician_id: yan.id, check_id: check.id, kind: 'health_allowance', status: 'paid', earned_week_start: '2026-09-07', covers_from: '2026-08-01', covers_to: '2026-08-31', amount_cents: 6000 });
    const board = await service.getScoreboard(yan.id, { now: NOW });
    expect(board.seasonBonus.grossCents).toBe(6000); // six weeks of 1000, every covered day in August
  });

  test('a stay bonus on a check, and the overtime it caused, are not in the season base; the commission beside it and its overtime are', async () => {
    const [rho] = await db('technicians').insert({ name: 'Sample Rho', hire_date: '2024-01-15' }).returning('id');
    const [run] = await db('payroll_runs').insert({ status: 'finalized', week_start: '2026-06-01', pay_date: '2026-06-12' }).returning('id');
    // 70,000 of wages, a 10,000 commission and a 30,000 stay bonus both earned in the week of May 4 (50 hours, 10 of them
    // overtime), and the 4,000 of overtime the two lines caused together: 1,000 from the commission, 3,000 from the bonus.
    // The row is an older one with no stored split and no earlier pay: the commission is priced alone from the row's hours.
    const [check] = await insertChecks([{
      run_id: run.id, technician_id: rho.id, status: 'finalized', week_start: '2026-06-01', gross_cents: 114000, regular_pay_cents: 70000, tech_rewards_cents: 30000,
      calc_snapshot: { lineOvertimeWeeks: [{ weekStart: '2026-05-04', workedMinutes: 3000, overtimeMinutes: 600, premiumCents: 4000 }] },
    }]).returning('id');
    await db('payroll_pay_lines').insert([
      { technician_id: rho.id, check_id: check.id, kind: 'commission', status: 'paid', earned_week_start: '2026-05-04', amount_cents: 10000 },
      { technician_id: rho.id, check_id: check.id, kind: 'stay_bonus', status: 'paid', earned_week_start: '2026-06-01', covers_from: '2026-05-04', covers_to: '2026-05-10', amount_cents: 30000 },
    ]);
    const board = await service.getScoreboard(rho.id, { now: NOW });
    expect(board.seasonBonus.grossCents).toBe(70000 + 10000 + 1000);
  });

  test('a week paid on two checks: a stay bonus on the second check never moves the season base', async () => {
    const [tau, twin] = await db('technicians').insert([{ name: 'Sample Tau', hire_date: '2024-01-15' }, { name: 'Sample Twin', hire_date: '2024-01-15' }]).returning('id');
    // inserted newest first: each check is read from its own rows, so the order they are stored or dated in changes nothing
    const [later, own] = await db('payroll_runs').insert([
      { status: 'finalized', week_start: '2026-06-01', pay_date: '2026-06-12' },
      { status: 'finalized', week_start: '2026-05-04', pay_date: '2026-05-15' },
    ]).returning('id');
    // The week of May 4: 45 hours, 5 of them overtime. Its own check paid a 600 commission and 33 of premium (33.33).
    // The later check paid another 600 commission for that week. Alone that commission pays 34 (the twin). With a 600 stay
    // bonus for the same week beside it the check paid 67 (Tau), and the pay run stored the commission's 34 with the week.
    const week = (premiumCents, extra = {}) => ({ lineOvertimeWeeks: [{ weekStart: '2026-05-04', workedMinutes: 2700, overtimeMinutes: 300, premiumCents, ...extra }] });
    const earlierPay = { earlierAllocatedCents: 600, earlierPremiumCents: 33 };
    const [tauLater, tauOwn, twinLater, twinOwn] = await insertChecks([
      { run_id: later.id, technician_id: tau.id, status: 'finalized', week_start: '2026-06-01', gross_cents: 70000 + 600 + 600 + 67, regular_pay_cents: 70000, tech_rewards_cents: 600, calc_snapshot: week(67, { ...earlierPay, ordinaryPremiumCents: 34 }) },
      { run_id: own.id, technician_id: tau.id, status: 'finalized', week_start: '2026-05-04', gross_cents: 70000 + 600 + 33, regular_pay_cents: 70000, calc_snapshot: week(33) },
      { run_id: later.id, technician_id: twin.id, status: 'finalized', week_start: '2026-06-01', gross_cents: 70000 + 600 + 34, regular_pay_cents: 70000, calc_snapshot: week(34, earlierPay) },
      { run_id: own.id, technician_id: twin.id, status: 'finalized', week_start: '2026-05-04', gross_cents: 70000 + 600 + 33, regular_pay_cents: 70000, calc_snapshot: week(33) },
    ]).returning('id');
    const commissionOn = (technician, check) => ({ technician_id: technician.id, check_id: check.id, kind: 'commission', status: 'paid', earned_week_start: '2026-05-04', amount_cents: 600 });
    await db('payroll_pay_lines').insert([
      commissionOn(tau, tauOwn), commissionOn(tau, tauLater), commissionOn(twin, twinOwn), commissionOn(twin, twinLater),
      { technician_id: tau.id, check_id: tauLater.id, kind: 'stay_bonus', status: 'paid', earned_week_start: '2026-06-01', covers_from: '2026-05-04', covers_to: '2026-05-10', amount_cents: 600 },
    ]);
    // both weeks' wages, both commissions, and the 67 the commissions were paid in overtime (33, then 34)
    const base = 140000 + 1200 + 67;
    expect((await service.getScoreboard(twin.id, { now: NOW })).seasonBonus.grossCents).toBe(base);
    // Tau: the same, with the stay bonus and the other 33 of the second check's 67 left out
    expect((await service.getScoreboard(tau.id, { now: NOW })).seasonBonus.grossCents).toBe(base);
  });

  test('review asks are counted in SQL on each send time: an initial ask outside the season does not drag its in-season follow-up out', async () => {
    const [c1, c2] = [randomUUID(), randomUUID()];
    const rows = await db('review_requests').insert([
      { technician_id: alpha, customer_id: c1, service_date: '2026-02-20', sms_sent_at: '2026-02-20T16:00:00Z', followup_delivered_at: '2026-03-05T16:00:00Z' }, // initial before Mar 1, follow-up inside
      { technician_id: alpha, customer_id: c2, service_date: '2026-08-25', sms_sent_at: '2026-08-25T16:00:00Z' }, // initial inside, follow-up after
    ]).returning(['id', 'customer_id']);
    await db('messaging_audit_log').insert({ customer_id: c2, entry_point: 'review_request_followup', metadata: { review_request_id: rows.find((r) => r.customer_id === c2).id }, sent_at: '2026-09-02T16:00:00Z' });
    const board = await service.getScoreboard(alpha, { now: NOW });
    expect(board.reviews.asks).toBe(2);
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

  describe('the season scores a pay run reads before its transaction opens (tech-rewards-pay-lines.js readSeasonScores)', () => {
    const SEASON_GATES = ['GATE_PAYROLL_PAY_LINES', 'GATE_TECH_REWARDS_SEASON_BONUS'];
    const OLD_GATES = Object.fromEntries(SEASON_GATES.map((name) => [name, process.env[name]]));
    const PAY_DATE = '2027-09-24'; // the last Friday of September 2027
    const recipient = { employment_type: 'w2', role: 'technician', employment_status: 'active', field_dispatchable: true, hire_date: '2024-01-10' };
    const keyOf = (id) => `season_bonus:${id}:2027`;
    const scored = (year) => ({ complete: true, year, parts: PARTS, score: 91.5, rateBps: 400, settings: { version: 0, weights: WEIGHTS, cutLines: CUTS } });
    let payLines;
    let made;

    beforeEach(async () => {
      payLines = require('../services/tech-rewards-pay-lines');
      for (const name of SEASON_GATES) process.env[name] = 'true';
      made = (await db('technicians').insert(['Sample Delta', 'Sample Echo', 'Sample Foxtrot'].map((name) => ({ name, ...recipient }))).returning('id'))
        .map((row) => row.id).sort();
    });
    afterEach(async () => {
      for (const name of SEASON_GATES) {
        if (OLD_GATES[name] === undefined) delete process.env[name];
        else process.env[name] = OLD_GATES[name];
      }
      await db('technicians').whereIn('id', made).del();
    });

    test('one REPEATABLE READ, read-only snapshot for every technician; one technician\'s failed read leaves the others; the connection is given back', async () => {
      const [first, second, settled] = made;
      // the third technician's 2027 bonus is settled: the pay run's own line, no longer open
      await db('payroll_pay_lines').insert({ technician_id: settled, kind: 'season_bonus', source_type: 'tech_rewards', source_id: keyOf(settled), status: 'paid', earned_week_start: '2027-09-13', amount_cents: 1000 });
      const seen = [];
      scores.buildSeasonScore.mockImplementation(async (id, year, season, trx) => {
        seen.push({
          id,
          level: (await trx.raw('SHOW transaction_isolation')).rows[0].transaction_isolation,
          readOnly: (await trx.raw('SHOW transaction_read_only')).rows[0].transaction_read_only,
          pid: (await trx.raw('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        });
        if (id === first) await trx.raw('SELECT 1 / 0'); // the first one read fails inside PostgreSQL
        return scored(year);
      });
      const read = await payLines.readSeasonScores(db, PAY_DATE);
      // Alpha and Beta get no Tech Rewards lines (not W-2 field technicians) and the settled bonus needs no score: none is read.
      // (Technicians that earlier tests of this suite left on file are read too; this test looks at its own three.)
      const mine = (list, idOf) => list.filter((item) => made.includes(idOf(item)));
      expect(read.failed).toBe(false);
      for (const id of [alpha, beta, settled]) expect(read.figures.has(keyOf(id))).toBe(false);
      expect(mine([...read.figures.keys()], (key) => key.split(':')[1])).toEqual([keyOf(first), keyOf(second)]);
      expect(read.figures.get(keyOf(first))).toBeNull();
      expect(read.figures.get(keyOf(second))).toMatchObject({ seasonScore: { complete: true, score: 91.5, year: 2027 }, asks: 0, reviews: 0 });
      expect(Object.keys(read.figures.get(keyOf(second))).sort()).toEqual(['asks', 'reviews', 'seasonScore', 'settings']);
      expect(mine(seen, (s) => s.id).map((s) => [s.id, s.level, s.readOnly])).toEqual([[first, 'repeatable read', 'on'], [second, 'repeatable read', 'on']]);
      expect(new Set(seen.map((s) => `${s.level} ${s.readOnly} ${s.pid}`)).size).toBe(1); // every technician: one snapshot, one connection
      expect(require('../services/logger').error).toHaveBeenCalledWith(expect.stringContaining(`season 2027 score could not be read for technician ${first}`));
      expect(db.client.pool.numUsed()).toBe(0); // given back before the pay run asks for its own
      // nothing is read for a run dated for no season bonus, or with a gate off
      seen.length = 0;
      expect(await payLines.readSeasonScores(db, '2027-09-17')).toBeNull();
      const [run] = await db('payroll_runs').insert({ status: 'draft', week_start: '2027-09-13', pay_date: PAY_DATE }).returning('id');
      expect(mine([...(await payLines.readSeasonScoresOfRun(db, run.id)).figures.keys()], (key) => key.split(':')[1])).toHaveLength(2);
      expect(await payLines.readSeasonScoresOfRun(db, randomUUID())).toBeNull(); // no such run
      seen.length = 0;
      delete process.env.GATE_TECH_REWARDS_SEASON_BONUS;
      expect([await payLines.readSeasonScores(db, PAY_DATE), await payLines.readSeasonScoresOfRun(db, run.id), seen]).toEqual([null, null, []]);
      // the snapshot itself cannot be taken: every bonus waits, and the pay run goes on
      process.env.GATE_TECH_REWARDS_SEASON_BONUS = 'true';
      const noConnection = { transaction: async () => { throw new Error('no connection'); } };
      expect(await payLines.readSeasonScores(noConnection, PAY_DATE)).toEqual({ figures: new Map(), failed: true });
    });

    test('with a pool of two connections that two pay runs hold, the read waits for a connection while it holds none, and runs when one is free', async () => {
      const knex = require('knex');
      const small = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [mockSchema], pool: { min: 0, max: 2 }, acquireConnectionTimeout: 20000 });
      const held = [];
      try {
        held.push(await small.transaction()); // the pay run that holds the payroll lock
        held.push(await small.transaction()); // a pay run that waits for that lock, and holds its connection while it waits
        const [holder, waiter] = held;
        await Promise.all([holder.raw('SELECT 1'), waiter.raw('SELECT 1')]);
        expect(small.client.pool.numUsed()).toBe(2);
        let done = false;
        const read = payLines.readSeasonScores(small, PAY_DATE).then((result) => { done = true; return result; });
        await new Promise((resolve) => { setTimeout(resolve, 400); });
        // a third pay run's score read: it waits in line and holds nothing, so the two pay runs are never held up by it
        expect([done, small.client.pool.numUsed(), small.client.pool.numPendingAcquires()]).toEqual([false, 2, 1]);
        await holder.commit();
        const result = await read;
        expect([result.failed, made.every((id) => result.figures.has(keyOf(id)))]).toEqual([false, true]);
        expect(small.client.pool.numUsed()).toBe(1); // the waiting pay run's own: the read gave its connection back
        await waiter.commit();
      } finally {
        for (const open of held) if (!open.isCompleted()) await open.rollback();
        await small.destroy();
      }
    });
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
    expect(Object.keys(list.find((t) => t.id === alpha)).sort()).toEqual(['id', 'name']);
  });

  test('also lists a former technician who has a finalized paycheck of a finalized run, marked not active, once', async () => {
    const add = async (name) => (await db('technicians').insert({ name, active: false }).returning('id'))[0].id;
    const [paid, never, draftOnly, voidedOnly, voidedRun] = [await add('Sample Former Paid'), await add('Sample Former Never'), await add('Sample Former Draft'), await add('Sample Former Voided'), await add('Sample Former Voided Run')];
    const [final, draft, voided] = (await db('payroll_runs').insert([
      { status: 'finalized', week_start: '2026-05-04', pay_date: '2026-05-15' },
      { status: 'draft', week_start: '2026-05-11', pay_date: '2026-05-22' },
      { status: 'voided', week_start: '2026-05-18', pay_date: '2026-05-29' },
    ]).returning('id')).map((r) => r.id);
    await insertChecks([
      { run_id: final, technician_id: paid, status: 'finalized', week_start: '2026-05-04', gross_cents: 100000 },
      { run_id: final, technician_id: paid, status: 'finalized', week_start: '2026-04-27', gross_cents: 100000 }, // two checks: still listed once
      { run_id: draft, technician_id: draftOnly, status: 'draft', week_start: '2026-05-11', gross_cents: 100000 },
      { run_id: final, technician_id: voidedOnly, status: 'voided', week_start: '2026-05-04', gross_cents: 100000 },
      { run_id: voided, technician_id: voidedRun, status: 'finalized', week_start: '2026-05-18', gross_cents: 100000 },
    ]);
    const list = await service.listTechnicians();
    expect(list.filter((t) => t.id === paid)).toEqual([{ id: paid, name: 'Sample Former Paid', active: false }]);
    for (const id of [never, draftOnly, voidedOnly, voidedRun]) expect(list.map((t) => t.id)).not.toContain(id);
    // an active technician is listed as before, with or without a paycheck, and never marked
    expect(list.filter((t) => t.id === alpha)).toEqual([{ id: alpha, name: 'Sample Alpha' }]);
    expect(list.map((t) => t.name)).toEqual([...list.map((t) => t.name)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });
});
