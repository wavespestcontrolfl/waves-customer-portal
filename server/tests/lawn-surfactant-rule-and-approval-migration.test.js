// The herbicide surfactant the 2026-10-28 garage count added gets LESCO 90/10 Nonionic Surfactant's rule and report copy
// (owner 2026-10-28, "make sure every product has it"). No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261029040000_lawn_surfactant_rule_and_approval');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const COLUMNS = ['id', 'name', 'post_application_watering', 'approved_for_service_report', 'service_report_summary',
  'customer_precaution_summary', 'reentry_summary', 'updated_at'];

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
  id: 'id-surfactant', name: migration.NAME, post_application_watering: null, approved_for_service_report: false,
  service_report_summary: null, customer_precaution_summary: null, reentry_summary: null, ...extra,
});

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('the rule validates; approved, the surfactant carries it and leaves the herbicide to set the text', () => {
  const rule = migration.FIELDS.post_application_watering.value;
  expect(validateRule(rule)).toMatchObject({ valid: true });
  const row = { name: migration.NAME, category: 'adjuvant', epa_reg_number: null,
    ...Object.fromEntries(Object.entries(migration.FIELDS).map(([column, { value }]) => [column, value])) };
  const facts = approvedReportProductFacts(row);
  expect(facts.wateringRule).toMatchObject({ mode: 'none', source: 'owner' });
  const herbicide = { name: 'Celsius WG', rule: { mode: 'hold', hold_hours: 24, source: 'owner', label_minimum: { hold_until: 'dry' } } };
  const ins = buildWateringInstruction({ rules: [herbicide, { name: migration.NAME, rule: facts.wateringRule }], completedAt: '2026-10-28T15:00:00Z', runtime: null, plainWhenNoSetup: true, labelFirst: true });
  expect(ins.state).toBe('hold');
});

test('fills the empty fields once, one audit row per write; admin values stand', async () => {
  const knex = fakeKnex({ rows: [open()] });
  await migration.up(knex);
  expect(knex.table[0]).toMatchObject({ approved_for_service_report: true, reentry_summary: 'Stay off treated areas until the application has dried.' });
  expect(JSON.parse(knex.table[0].post_application_watering)).toEqual(migration.FIELDS.post_application_watering.value);
  expect(recordAuditEvent).toHaveBeenCalledTimes(5);
  recordAuditEvent.mockClear();
  await migration.up(knex);
  expect(recordAuditEvent).not.toHaveBeenCalled();

  const edited = fakeKnex({ rows: [open({ approved_for_service_report: true, reentry_summary: 'Custom.' })] });
  await migration.up(edited);
  expect(edited.table[0].reentry_summary).toBe('Custom.');
  expect(recordAuditEvent.mock.calls.map(([e]) => e.metadata.column).sort())
    .toEqual(['customer_precaution_summary', 'post_application_watering', 'service_report_summary']);
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
