// Quali-Pro Imidacloprid 2F T&O (added by the 2026-10-28 garage count) gets its label EPA number, Dominion 2L's watering
// rule and Merit 2F's report copy (owner 2026-10-28, "make sure every product has it"). No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261029050000_lawn_imidacloprid_2f_rule_and_approval');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const COLUMNS = ['id', 'name', ...Object.keys(migration.FIELDS), 'updated_at'];
const DIMENSION = { name: 'LESCO Dimension 18-0-10', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'owner' } };

function fakeKnex({ rows, columns = COLUMNS, tables = ['products_catalog', 'audit_log'] }) {
  const table = rows.map((row) => ({ ...row }));
  const knex = (name) => {
    expect(name).toBe('products_catalog');
    const filters = [];
    const builder = {
      where(a, b) {
        if (typeof a === 'object') Object.entries(a).forEach(([k, v]) => filters.push((r) => r[k] === v));
        else filters.push((r) => r[a] === b);
        return builder;
      },
      whereNull(column) { filters.push((r) => r[column] == null); return builder; },
      select() { return Promise.resolve(table.filter((r) => filters.every((f) => f(r))).map((r) => ({ ...r }))); },
      async update(values) {
        const hit = table.filter((r) => filters.every((f) => f(r)));
        hit.forEach((r) => Object.assign(r, values));
        return hit.length;
      },
    };
    return builder;
  };
  knex.fn = { now: () => 'now()' };
  knex.schema = {
    hasTable: async (t) => tables.includes(t),
    hasColumn: async (t, c) => t === 'products_catalog' && columns.includes(c),
  };
  knex.table = table;
  return knex;
}
const open = (extra = {}) => ({
  id: 'id-imid', name: migration.NAME, epa_reg_number: null, label_url: null, post_application_watering: null,
  approved_for_service_report: false, service_report_summary: null, customer_precaution_summary: null,
  reentry_summary: null, moa_group: null, ...extra,
});

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('the rule validates; with the EPA number and approval the product carries it and builds a customer text', () => {
  expect(validateRule(migration.FIELDS.post_application_watering.value)).toMatchObject({ valid: true });
  const row = { name: migration.NAME, category: 'insecticide',
    ...Object.fromEntries(Object.entries(migration.FIELDS).map(([column, { value }]) => [column, value])) };
  const facts = approvedReportProductFacts(row);
  expect(facts.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, label_window: 'directs' });
  // Without the EPA number an approved insecticide freezes no facts: the EPA fill is what lets the rule through.
  expect(approvedReportProductFacts({ ...row, epa_reg_number: null })).toBeNull();
  for (const rules of [[{ name: migration.NAME, rule: facts.wateringRule }], [DIMENSION, { name: migration.NAME, rule: facts.wateringRule }]]) {
    const ins = buildWateringInstruction({ rules, completedAt: '2026-10-28T15:00:00Z', runtime: null, plainWhenNoSetup: true, labelFirst: true });
    expect(ins.state).toBe('water_in');
  }
});

test('fills every empty field once, one audit row per write; a value written first stands', async () => {
  const knex = fakeKnex({ rows: [open()] });
  await migration.up(knex);
  expect(knex.table[0]).toMatchObject({ epa_reg_number: '66222-203', approved_for_service_report: true, moa_group: 'Group 4A' });
  expect(recordAuditEvent).toHaveBeenCalledTimes(8);
  recordAuditEvent.mockClear();
  await migration.up(knex);
  expect(recordAuditEvent).not.toHaveBeenCalled();

  const first = fakeKnex({ rows: [open({ epa_reg_number: '66222-999', label_url: 'https://example.invalid/label.pdf' })] });
  await migration.up(first);
  expect(first.table[0]).toMatchObject({ epa_reg_number: '66222-999', label_url: 'https://example.invalid/label.pdf' });
  expect(recordAuditEvent.mock.calls.map(([e]) => e.metadata.column)).not.toContain('epa_reg_number');
});

test('no row, no table or no audit_log does not fail; down is a no-op', async () => {
  await expect(migration.up(fakeKnex({ rows: [] }))).resolves.toBeUndefined();
  await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
  const noAudit = fakeKnex({ rows: [open()], tables: ['products_catalog'] });
  await migration.up(noAudit);
  expect(noAudit.table[0].approved_for_service_report).toBe(true);
  const snapshot = JSON.stringify(noAudit.table);
  await migration.down(noAudit);
  expect(JSON.stringify(noAudit.table)).toBe(snapshot);
});
