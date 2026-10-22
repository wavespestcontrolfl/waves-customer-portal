/**
 * GATE_PREPAY_REFUND_90_DAY (owner R7, 2026-10-22): a term ended now more than 90 days after its start gets no
 * refund, so the coverage reader itself stops treating it as covered (pre-push P1: no refund would ever revoke it).
 * The SQL is built offline (no database): gate off = the same query as before; gate on = one extra exclusion.
 */
jest.mock('../models/db', () => require('knex')({ client: 'pg' }));
const knex = require('knex')({ client: 'pg' });
const { coveredTermsAsOf } = require('../services/annual-prepay-renewals');

const GATE = 'GATE_PREPAY_REFUND_90_DAY';
const sqlOf = () => coveredTermsAsOf(knex, '2026-10-22').toString();
const CLAUSE = "not (t.cancel_disposition is not distinct from 'end_now_refund' and t.renewal_decision_at is not null and (t.renewal_decision_at at time zone 'America/New_York')::date > t.term_start + 90)";

afterEach(() => { delete process.env[GATE]; });

test('gate off: the coverage query is unchanged (no 90-day exclusion)', () => {
  expect(sqlOf()).not.toContain('term_start + 90');
});

test('gate on: an end-now lapse decided after day 90 is excluded from coverage, inside the lapsed-renewal leg only', () => {
  process.env[GATE] = 'true';
  const sql = sqlOf();
  expect(sql).toContain(CLAUSE);
  const leg = sql.slice(sql.indexOf('"t"."renewal_decision" = \'cancel\''));
  expect(leg.indexOf(CLAUSE)).toBeGreaterThan(-1);
  expect(leg.indexOf(CLAUSE)).toBeLessThan(200);
});

test('any gate value other than "true" leaves the query unchanged', () => {
  process.env[GATE] = '1';
  expect(sqlOf()).not.toContain('term_start + 90');
});
