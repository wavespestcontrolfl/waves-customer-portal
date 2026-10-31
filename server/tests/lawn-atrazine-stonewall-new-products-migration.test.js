// LESCO Stonewall 0.43% 0-0-8 (added by the 2026-10-29 garage count) gets a watering rule, report approval and label
// fields; LESCO Atrazine 0.92% 20-0-20 gets label fields only, its rule waiting for the owner (owner 2026-10-28, "make
// sure every product has it"). No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261029140000_lawn_atrazine_stonewall_new_products');
const { validateRule, rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const [ATRAZINE, STONEWALL] = migration.ITEMS;
const COLUMNS = ['id', 'name', 'post_application_watering', 'approved_for_service_report', 'service_report_summary',
  'customer_precaution_summary', 'reentry_summary', 'service_lines',
  ...new Set(migration.ITEMS.flatMap((item) => Object.keys(item.fields))), 'updated_at'];
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
// The row as the garage count wrote it: every catalog field here is empty, the approval flag is false.
const open = (item, extra = {}) => ({
  ...Object.fromEntries(COLUMNS.map((column) => [column, column === 'approved_for_service_report' ? false : null])),
  id: `id-${item.name.slice(6, 15)}`,
  name: item.name,
  ...extra,
});
const build = (rules) => buildWateringInstruction({ rules, completedAt: '2026-10-28T15:00:00Z', runtime: null, plainWhenNoSetup: true, labelFirst: true });

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('Stonewall: the rule validates, approval carries it, and every target case builds a customer text', () => {
  const rule = STONEWALL.fields.post_application_watering.value;
  expect(validateRule(rule)).toMatchObject({ valid: true });
  const row = { name: STONEWALL.name, category: 'herbicide', epa_reg_number: '10404-89',
    ...Object.fromEntries(Object.entries(STONEWALL.fields).map(([column, { value }]) => [column, value])) };
  const facts = approvedReportProductFacts(row);
  expect(facts.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336 });
  // The garage count's row (not approved) freezes no facts, so it carries no rule into the text.
  expect(approvedReportProductFacts({ ...row, approved_for_service_report: false })).toBeNull();
  const targets = STONEWALL.fields.target_pests.value;
  for (const logged of [[], targets.slice(0, 3), ...targets.map((t) => [t]), targets]) {
    const picked = rulesForTargets(facts.wateringRule, logged, { labelTargets: targets });
    expect(picked.length).toBeGreaterThan(0);
    const mine = picked.map((r) => ({ name: STONEWALL.name, rule: r }));
    for (const rules of [mine, [DIMENSION, ...mine]]) expect(build(rules).state).toBe('water_in');
  }
  const alone = build([{ name: STONEWALL.name, rule }]);
  expect(alone).toMatchObject({ waterInInches: 0.5, waterInBy: '2026-11-11T15:00:00.000Z' });
  expect(alone.lines).toContain('Rain and your regular watering both count.');
});

test('Atrazine gets label fields only: no rule, approval, report copy or service line', () => {
  for (const column of ['post_application_watering', 'approved_for_service_report', 'service_report_summary',
    'customer_precaution_summary', 'reentry_summary', 'service_lines']) {
    expect(ATRAZINE.fields).not.toHaveProperty(column);
  }
});

test('fills every empty field once with one audit row per write; JSON columns are written as JSON', async () => {
  const knex = fakeKnex({ rows: [open(ATRAZINE), open(STONEWALL)] });
  await migration.up(knex);
  const [atrazine, stonewall] = knex.table;
  expect(atrazine).toMatchObject({ moa_group: 'Group 5', rate_unit: 'lb', default_rate_per_1000: 3.74, max_label_rate_per_1000: 5 });
  // Still unapproved with no rule: a visit that logs it keeps the office alert until the owner decides its watering.
  expect(atrazine).toMatchObject({ approved_for_service_report: false, post_application_watering: null, service_lines: null });
  expect(JSON.parse(atrazine.target_pests)).toEqual(ATRAZINE.fields.target_pests.value);
  expect(stonewall).toMatchObject({ approved_for_service_report: true, moa_group: 'Group 3', hrac_group: '3', max_label_rate_per_1000: 5.34 });
  for (const column of ['post_application_watering', 'target_pests', 'service_lines']) {
    expect(JSON.parse(stonewall[column])).toEqual(STONEWALL.fields[column].value);
  }
  const writes = Object.keys(ATRAZINE.fields).length + Object.keys(STONEWALL.fields).length;
  expect(recordAuditEvent).toHaveBeenCalledTimes(writes);
  expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({ resource_type: 'products_catalog', critical: true });
  recordAuditEvent.mockClear();
  await migration.up(knex);
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('a value written first stands, and an approval already given is not re-audited', async () => {
  const first = fakeKnex({ rows: [open(STONEWALL, {
    label_url: 'https://example.invalid/label.pdf',
    post_application_watering: { mode: 'none', source: 'owner' },
    approved_for_service_report: true,
  })] });
  await migration.up(first);
  expect(first.table[0]).toMatchObject({ label_url: 'https://example.invalid/label.pdf', post_application_watering: { mode: 'none', source: 'owner' } });
  const columns = recordAuditEvent.mock.calls.map(([e]) => e.metadata.column);
  for (const column of ['label_url', 'post_application_watering', 'approved_for_service_report']) expect(columns).not.toContain(column);
  expect(columns).toContain('sds_url');
});

test('a missing column is skipped; no row, no table or no audit_log does not fail; down is a no-op', async () => {
  const noHrac = fakeKnex({ rows: [open(STONEWALL)], columns: COLUMNS.filter((c) => c !== 'hrac_group') });
  await migration.up(noHrac);
  expect(noHrac.table[0].approved_for_service_report).toBe(true);
  expect(recordAuditEvent).toHaveBeenCalledTimes(Object.keys(STONEWALL.fields).length - 1);
  await expect(migration.up(fakeKnex({ rows: [] }))).resolves.toBeUndefined();
  await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
  const noAudit = fakeKnex({ rows: [open(STONEWALL)], tables: ['products_catalog'] });
  recordAuditEvent.mockClear();
  await migration.up(noAudit);
  expect(noAudit.table[0].approved_for_service_report).toBe(true);
  expect(recordAuditEvent).not.toHaveBeenCalled();
  const snapshot = JSON.stringify(noAudit.table);
  await migration.down(noAudit);
  expect(JSON.stringify(noAudit.table)).toBe(snapshot);
});
