// Compile with Knex's PostgreSQL dialect; no database connection is opened.
jest.mock('../models/db', () => require('knex')({ client: 'pg' }));
const db = require('../models/db');
const { _private: helpers } = require('../routes/admin-customers');
const columns = new Set(['id', 'overall_score', 'score_grade', 'churn_risk', 'churn_probability', 'scored_at']);

function compile(filters) {
  return helpers.applyCustomerListFilters(db('customers').whereNull('customers.deleted_at'), filters, columns).toSQL();
}

test('validates health filters, preserving zero and rejecting malformed or inverted ranges', () => {
  expect(helpers.customerHealthFilterSchema.validate({ minHealthScore: '0', maxHealthScore: '0', minChurnProbability: '0' }).value)
    .toEqual({ minHealthScore: 0, maxHealthScore: 0, minChurnProbability: 0 });
  expect(helpers.customerHealthFilterSchema.validate({ maxHealthScore: '50' }).error).toBeUndefined();
  for (const input of [{ healthGrade: "A' OR 1=1" }, { healthRisk: ['low', 'high'] }, { minHealthScore: '' }, { maxHealthScore: 101 }, { minChurnProbability: -1 }, { minHealthScore: 80, maxHealthScore: 20 }]) {
    expect(helpers.customerHealthFilterSchema.validate(input).error).toBeDefined();
  }
});

test('composes health, identity and service filters before pagination and count', () => {
  const filters = { search: 'sample', tier: 'Gold', healthGrade: 'A', healthRisk: 'low', minHealthScore: 0, maxHealthScore: 100, minChurnProbability: 50 };
  const query = helpers.applyCustomerListFilters(db('customers'), filters, columns);
  const count = query.clone().count('* as count').toSQL();
  const page = query.clone().select('*').limit(10).offset(20).toSQL();
  expect(page.bindings.slice(0, -2)).toEqual(count.bindings);
  expect(count.bindings).toEqual(expect.arrayContaining(['Gold', 'A', 'low', 'healthy', 0, 100, 0.5]));
  expect(page.sql).toContain('"customers"');
  expect(page.sql).toContain('ORDER BY "scored_at" DESC NULLS LAST, id DESC LIMIT 1');
  expect(page.sql).toContain('"score_grade"');
  expect(page.sql).not.toContain('sample');
});

test('ungraded and absent-schema reads stay unknown instead of inventing a grade', () => {
  expect(compile({ healthGrade: 'ungraded' }).sql).toContain('is null');
  expect(helpers.latestHealthValueRaw(new Set(), 'grade').toSQL().sql).toBe('NULL');
  expect(helpers.mapCustomerListRow({ health_score: 99 }).healthGrade).toBeNull();
  expect(helpers.mapCustomerListRow({ health_score: 0, health_grade: 'F' })).toMatchObject({ healthScore: 0, healthGrade: 'F' });
});

test.each([
  ['low', ['low', 'healthy']], ['moderate', ['moderate', 'watch']],
  ['high', ['high', 'at_risk']], ['at_risk', ['high', 'at_risk', 'critical']],
])('risk filter %s includes both recorded vocabularies', (healthRisk, values) => {
  expect(compile({ healthRisk }).bindings).toEqual(values);
});

test.each([
  ['outreach_sent', 'retention_outreach', ['sent', 'completed', 'customer_responded', 'save_successful', 'save_failed']],
  ['saved', 'retention_outreach', ['retained', 'save_successful']],
  ['revenue_saved', 'retention_outreach', ['retained', 'save_successful', 0]],
  ['upsell_accepted', 'upsell_opportunities', ['accepted']],
  ['upsell_revenue', 'upsell_opportunities', ['accepted', 0]],
])('retention filter %s uses the existing 30-day creation cohort without duplicating customers', (retention, table, outcomes) => {
  const since = new Date(Date.now() - 30 * 86400000);
  const result = compile({ retention, retentionSince: since });
  expect(result.sql).toContain(`exists (select "customer_id" from "${table}"`);
  expect(result.sql).toContain('"created_at" > ?');
  expect(result.bindings).toEqual([since, ...outcomes]);
  if (retention === 'revenue_saved') expect(result.sql).toContain('"revenue_saved" > ?');
  if (retention === 'upsell_revenue') expect(result.sql).toContain('"estimated_monthly_value" > ?');
});

test('technicians cannot infer private health or retention from result membership or rows', () => {
  const requested = { search: 'sample', healthGrade: 'F', healthRisk: 'critical', minHealthScore: 0, maxHealthScore: 40, minChurnProbability: 80, retention: 'saved' };
  expect(helpers.techSafeListFilters(requested)).toMatchObject({ search: 'sample' });
  expect(compile(helpers.techSafeListFilters(requested)).sql).not.toMatch(/customer_health_scores|retention_outreach/);
  expect(helpers.techSafeListRow(helpers.mapCustomerListRow({ health_score: 0, health_grade: 'F' }))).not.toHaveProperty('healthGrade');
});
