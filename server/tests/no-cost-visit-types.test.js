// no-cost-visit-types: the always-free service-type terms match as WHOLE
// WORDS ('-', ' ' and '_' are separators). As bare substrings, 're service' matched "Lawn Ca-re Service",
// so every "Monthly / Every 6 Weeks Lawn Care Service" visit read as
// always-free from 2026-06-19 (#1926): skipped by the completion billing
// gates, excluded from the billing-recovery leak queue, and flagged by the
// closeout fact as an invoice on a free visit (ops-inbox triage 2026-09-05
// lane 5). The SQL regex the two query consumers bind must agree with the
// JS predicate on the same fixtures — the Postgres half runs only when
// DATABASE_URL is set (any database: it evaluates a bare `~*`).
const { ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX, isAlwaysFreeServiceType } = require('../services/no-cost-visit-types');

const BILLABLE = [
  'Every 6 Weeks Lawn Care Service',
  'Monthly Lawn Care Service',
  'Tree & Shrub Care Service',
  'Quarterly Pest Control Service',
  'Termite Treatment',
  'Lawn Care',
  'Estimated Pricing Review', // 'estimate' is not a prefix match either
  'lawn_care_service', // key-shaped: '_' is a separator, and 'care service' still is not a re-service
  'Prestimate', // no suffix match either
];
const ALWAYS_FREE = [
  'Pest Control Re-Service',
  'Lawn Care Re-Service',
  'Lawn Care Reservice',
  'Pest re service',
  'Bed Bug Follow-Up Visit',
  'Follow up',
  'Followup',
  'Re-Visit',
  'Revisit - Ants',
  'Estimate',
  'Waves Pest Control Appointment Service',
  'ESTIMATE VISIT',
  // key-shaped forms (the helper's header documents general_appointment)
  'general_appointment',
  'pest_re_service',
  'follow_up',
  're_visit',
  'estimate_visit',
  'Re_Service',
];

describe('isAlwaysFreeServiceType', () => {
  test.each(BILLABLE)('%s is billable', (t) => {
    expect(isAlwaysFreeServiceType(t)).toBe(false);
  });
  test.each(ALWAYS_FREE)('%s is always free', (t) => {
    expect(isAlwaysFreeServiceType(t)).toBe(true);
  });
  test('empty / null are billable', () => {
    expect(isAlwaysFreeServiceType('')).toBe(false);
    expect(isAlwaysFreeServiceType(null)).toBe(false);
  });
});

const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
postgres('ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX agrees with the JS predicate in Postgres', () => {
  let knex;
  beforeAll(() => {
    knex = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 } });
  });
  afterAll(async () => { await knex.destroy(); });
  test.each([...BILLABLE, ...ALWAYS_FREE])('%s', async (t) => {
    const row = await knex.raw('SELECT ? ~* ? AS free', [t, ALWAYS_FREE_SERVICE_TYPE_SQL_REGEX]);
    expect(row.rows[0].free).toBe(isAlwaysFreeServiceType(t));
  });
});
