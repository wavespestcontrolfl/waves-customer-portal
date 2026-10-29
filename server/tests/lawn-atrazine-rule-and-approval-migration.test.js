// LESCO Atrazine 0.92% 20-0-20 weed & feed gets a 1-hour water-in rule, report approval and the label's written
// instruction (owner 2026-10-29, option a: "the text says to water in within 1 hour, and the report prints the label's
// line"). No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261029150000_lawn_atrazine_rule_and_approval');
const { validateRule, rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const COLUMNS = ['id', 'name', ...Object.keys(migration.FIELDS), 'updated_at'];
const RULE = migration.FIELDS.post_application_watering.value;
const DIMENSION = { name: 'LESCO Dimension 18-0-10', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'owner' } };
// The targets 20261029140000 fills on the row.
const TARGETS = ['Dollarweed', 'Florida pusley', 'Crabgrass (pre-emergent)', 'Spurge', 'Annual bluegrass (Poa annua)', 'Chickweed'];

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
// The row as the garage count wrote it.
const open = (extra = {}) => ({
  id: 'id-atrazine', name: migration.NAME, post_application_watering: null, approved_for_service_report: false,
  service_report_summary: null, customer_precaution_summary: null, reentry_summary: null, service_lines: null, ...extra,
});
const build = (rules, completedAt = '2026-10-28T15:00:00Z') => buildWateringInstruction({ rules, completedAt, runtime: null, plainWhenNoSetup: true, labelFirst: true });

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('the rule validates; approval carries it; every target case builds a text alone and beside Dimension', () => {
  expect(validateRule(RULE)).toMatchObject({ valid: true });
  const row = { name: migration.NAME, category: 'herbicide', epa_reg_number: '10404-96',
    ...Object.fromEntries(Object.entries(migration.FIELDS).map(([column, { value }]) => [column, value])) };
  const facts = approvedReportProductFacts(row);
  expect(facts.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 1, label_window: 'directs' });
  expect(facts.precautionSummary).toMatch(/^This product must be watered in immediately\./);
  // The row as the garage count left it (not approved) freezes no facts.
  expect(approvedReportProductFacts({ ...row, approved_for_service_report: false })).toBeNull();
  for (const logged of [[], TARGETS.slice(0, 3), ...TARGETS.map((t) => [t]), TARGETS]) {
    const picked = rulesForTargets(facts.wateringRule, logged, { labelTargets: TARGETS });
    expect(picked.length).toBeGreaterThan(0);
    const mine = picked.map((r) => ({ name: migration.NAME, rule: r }));
    for (const rules of [mine, [DIMENSION, ...mine]]) expect(build(rules).state).toBe('water_in');
  }
});

test('the text gives a deadline 1 hour after the visit, never the same-day 11 PM', () => {
  const morning = build([{ name: migration.NAME, rule: RULE }]);
  expect(morning).toMatchObject({ waterInInches: 0.25, waterInBy: '2026-10-28T16:00:00.000Z' });
  expect(morning.lines[0]).toMatch(/^Water in today.s treatment with about ¼ inch by 12 PM today\.$/);
  const evening = build([{ name: migration.NAME, rule: RULE }], '2026-10-28T22:30:00Z');
  expect(evening.waterInBy).toBe('2026-10-28T23:30:00.000Z');
  expect(evening.lines.join(' ')).not.toMatch(/11 PM/);
  const withDimension = build([DIMENSION, { name: migration.NAME, rule: RULE }]);
  expect(withDimension.lines[0]).toBe(morning.lines[0]);
  expect(withDimension.lines.join(' ')).toMatch(/about ½ inch of water by Wed, Nov 11/);
});

test('beside a product that must stay dry, the two directions clash: no text (the office alert path)', () => {
  const keepDry = { name: 'A fungicide spray', rule: { mode: 'hold', source: 'label', hold_until: 'dry' } };
  const clash = build([{ name: migration.NAME, rule: RULE }, keepDry]);
  expect(clash.state).toBeFalsy();
  expect(clash.noClaim).toMatchObject({ reason: 'water_in_conflict' });
});

test('every audit action fits audit_log.action (varchar 96); the mock would not catch an overflow', async () => {
  const knex = fakeKnex({ rows: [open()] });
  await migration.up(knex);
  const actions = recordAuditEvent.mock.calls.map(([e]) => e.action);
  expect(actions).toHaveLength(Object.keys(migration.FIELDS).length);
  for (const action of actions) {
    expect(action).toMatch(new RegExp(`^migration:${migration.MIGRATION}:`));
    expect(action.length).toBeLessThanOrEqual(96);
  }
});

test('fills every empty field once with one audit row per write; JSON columns are written as JSON', async () => {
  const knex = fakeKnex({ rows: [open()] });
  await migration.up(knex);
  const [row] = knex.table;
  expect(row).toMatchObject({ approved_for_service_report: true, reentry_summary: migration.FIELDS.reentry_summary.value });
  expect(JSON.parse(row.post_application_watering)).toEqual(RULE);
  expect(JSON.parse(row.service_lines)).toEqual(['lawn']);
  expect(recordAuditEvent).toHaveBeenCalledTimes(Object.keys(migration.FIELDS).length);
  recordAuditEvent.mockClear();
  await migration.up(knex);
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('a value written first stands; missing column, no row, no table or no audit_log does not fail; down is a no-op', async () => {
  const first = fakeKnex({ rows: [open({ post_application_watering: { mode: 'none', source: 'owner' }, approved_for_service_report: true })] });
  await migration.up(first);
  expect(first.table[0].post_application_watering).toEqual({ mode: 'none', source: 'owner' });
  const columns = recordAuditEvent.mock.calls.map(([e]) => e.metadata.column);
  expect(columns).not.toContain('post_application_watering');
  expect(columns).not.toContain('approved_for_service_report');
  expect(columns).toContain('customer_precaution_summary');

  const noLines = fakeKnex({ rows: [open()], columns: COLUMNS.filter((c) => c !== 'service_lines') });
  await migration.up(noLines);
  expect(noLines.table[0].approved_for_service_report).toBe(true);
  await expect(migration.up(fakeKnex({ rows: [] }))).resolves.toBeUndefined();
  await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
  recordAuditEvent.mockClear();
  const noAudit = fakeKnex({ rows: [open()], tables: ['products_catalog'] });
  await migration.up(noAudit);
  expect(noAudit.table[0].approved_for_service_report).toBe(true);
  expect(recordAuditEvent).not.toHaveBeenCalled();
  const snapshot = JSON.stringify(noAudit.table);
  await migration.down(noAudit);
  expect(JSON.stringify(noAudit.table)).toBe(snapshot);
});
