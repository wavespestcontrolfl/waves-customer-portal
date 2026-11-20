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
      t.date('earned_week_start').notNullable();
      t.integer('amount_cents').notNullable();
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
      { name: 'Sample Alpha', hire_date: '2025-04-01' }, { name: 'Sample Beta', hire_date: '2024-01-15' },
    ]).returning('id');
  });

  afterAll(async () => {
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  beforeEach(async () => {
    for (const table of ['payroll_checks', 'payroll_runs', 'payroll_pay_lines', 'review_incentive_payouts', 'review_requests']) await db(table).del();
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
    await db('payroll_pay_lines').insert([
      { technician_id: alpha, kind: 'commission', status: 'paid', earned_week_start: '2026-04-06', amount_cents: 20000 },
      { technician_id: alpha, kind: 'commission', status: 'open', earned_week_start: '2026-11-09', amount_cents: 10000 },
      { technician_id: alpha, kind: 'commission', status: 'voided', earned_week_start: '2026-05-04', amount_cents: 5000 },
      { technician_id: alpha, kind: 'commission', status: 'paid', earned_week_start: '2025-12-29', amount_cents: 4000 }, // last year
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
      { technician_id: beta, service_date: '2026-04-10', sms_sent_at: '2026-04-10T16:00:00Z' },
    ]);
  }

  test('sums only the technician own finalized figures for the season it shows', async () => {
    await seed();
    const board = await service.getScoreboard(alpha, { now: NOW });
    expect(board.technician).toEqual({ id: alpha, name: 'Sample Alpha' });
    expect(board.season).toMatchObject({ year: 2026, status: 'final' });
    expect(scores.buildSeasonScore).toHaveBeenCalledWith(alpha, 2026, { start: '2026-03-01', end: '2026-08-31' }, expect.anything());
    expect(board.seasonBonus.grossCents).toBe(150000); // Mar 2 + Aug 31 weeks only
    expect(board.reviews).toMatchObject({ count: 3, asks: 2, rateBps: 10000 });
    expect(board.commission).toEqual({ year: 2026, yearToDateCents: 30000, paidCents: 20000, pendingCents: 10000 });
    // hired 2025-04-01: next stay bonus is the 3-year one; prior 12 months of pay (2025-11-20 .. 2026-11-20): 100000+50000+70000+10000
    expect(board.stayBonus).toMatchObject({ dueDate: '2028-04-01', years: 3, estimateCents: Math.round(230000 * 0.04) });
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
