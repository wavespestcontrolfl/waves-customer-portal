/**
 * save_weekly_report keeps ONE Weekly BI report per ET week (Codex #4870
 * r6). A retried or overlapping run, or an insert that finished after its
 * run hit the deadline, replaces the week's row instead of adding a second
 * dashboard report. Runs against the migrated schema (the week_of column and
 * its unique index, migration 20260926160000), inside a rolled-back
 * transaction.
 */
const path = require('path');

const SKIP = !process.env.DATABASE_URL;
const describeOrSkip = SKIP ? describe.skip : describe;

let mockTrx;
jest.mock('../models/db', () => {
  const forward = (...args) => mockTrx(...args);
  forward.raw = (...args) => mockTrx.raw(...args);
  forward.fn = { now: () => mockTrx.fn.now() };
  return forward;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describeOrSkip('save_weekly_report on PostgreSQL', () => {
  let knex;
  let executeBITool;
  let etWeekStart;
  beforeAll(() => {
    const config = require(path.join(__dirname, '..', 'knexfile.js'));
    knex = require('knex')(config.development || config);
    ({ executeBITool } = require('../services/bi-agent-tools'));
    ({ etWeekStart } = require('../utils/datetime-et'));
  });
  afterAll(async () => { if (knex) await knex.destroy(); });

  const report = (summary) => ({
    summary,
    revenue_section: 'rev',
    customer_section: 'cust',
    operations_section: 'Ops 7d: all on target',
    ads_section: 'ads',
    reviews_section: 'reviews',
    content_seo_section: 'seo',
    anomalies_section: 'none',
    action_items: 'none',
  });

  test('a second save in the same ET week replaces the week\'s report instead of adding one', async () => {
    const ROLLBACK = new Error('rollback');
    await expect(knex.transaction(async (trx) => {
      mockTrx = trx;
      const first = await executeBITool('save_weekly_report', report('first run'));
      const second = await executeBITool('save_weekly_report', report('retried run'));
      expect(first).toMatchObject({ saved: true });
      expect(second).toMatchObject({ saved: true, reportId: first.reportId });
      const rows = await trx('weekly_bi_reports').where({ week_of: etWeekStart() }).select('summary');
      expect(rows).toEqual([{ summary: 'retried run' }]);
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });

  test('rows saved before week_of existed (NULL) never block a save', async () => {
    const ROLLBACK = new Error('rollback');
    await expect(knex.transaction(async (trx) => {
      mockTrx = trx;
      await trx('weekly_bi_reports').insert([{ summary: 'legacy a' }, { summary: 'legacy b' }]);
      await expect(executeBITool('save_weekly_report', report('this week'))).resolves.toMatchObject({ saved: true });
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
  });
});
