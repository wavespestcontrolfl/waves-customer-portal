// Five lawn products added by the 2026-10-28 garage count get a label-checked watering rule and report approval (owner
// 2026-10-28, "make sure every product has it"). No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261029030000_lawn_new_products_rules_and_approvals');
const { validateRule, rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const NAME = '20261029030000_lawn_new_products_rules_and_approvals';
const COLUMNS = ['id', 'name', 'post_application_watering', 'approved_for_service_report', 'service_report_summary',
  'customer_precaution_summary', 'reentry_summary', 'moa_group', 'updated_at'];
const DIMENSION = { name: 'LESCO Dimension 18-0-10', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'owner' } };
// Catalog identity on the rows (production, 2026-10-28): report facts need a valid EPA number for a pesticide.
const CATALOG = {
  'The Andersons 17-0-3 Fertilizer with Grubout Plus': { category: 'insecticide', epa_reg_number: '228-610-9198' },
  'Thuricide BT Caterpillar Control': { category: 'insecticide', epa_reg_number: '70051-106-829' },
};
const item = (name) => migration.ITEMS.find((i) => i.name === name);
const ruleOf = (name) => item(name).fields.post_application_watering.value;

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
const open = (name, extra = {}) => ({
  id: `id-${name}`, name, post_application_watering: null, approved_for_service_report: false, service_report_summary: null,
  customer_precaution_summary: null, reentry_summary: null, moa_group: null, ...extra,
});
const stored = (knex, name) => knex.table.find((r) => r.name === name);

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('the five products (pure)', () => {
  test('each rule passes the validator with a label or owner source and the 10-28 check stamp', () => {
    expect(migration.ITEMS).toHaveLength(5);
    for (const { name } of migration.ITEMS) {
      expect({ name, ...validateRule(ruleOf(name)) }).toMatchObject({ name, valid: true });
      expect(['label', 'owner']).toContain(ruleOf(name).source);
      expect(ruleOf(name)).toMatchObject({ verified_by: 'label-check-2026-10-28' });
    }
  });

  test('approved, each product carries its rule into the report facts, and alone or beside Dimension builds a text', () => {
    for (const { name, fields } of migration.ITEMS) {
      const row = {
        name, category: 'fertilizer', epa_reg_number: 'N/A', ...CATALOG[name],
        ...Object.fromEntries(Object.entries(fields).map(([column, { value }]) => [column, value])),
      };
      const facts = approvedReportProductFacts(row);
      expect({ name, mode: facts && facts.wateringRule && facts.wateringRule.mode }).toEqual({ name, mode: ruleOf(name).mode });
      const mine = rulesForTargets(facts.wateringRule, [], { labelTargets: null }).map((rule) => ({ name, rule }));
      for (const rules of [mine, [DIMENSION, ...mine]]) {
        const ins = buildWateringInstruction({ rules, completedAt: '2026-10-28T15:00:00Z', runtime: null, plainWhenNoSetup: true, labelFirst: true });
        expect({ name, state: ins.state, noClaim: ins.noClaim || null }).toMatchObject({ name, state: expect.any(String), noClaim: null });
      }
    }
  });

  test('the labels decide the shape: GrubOut Plus waters in the same day, the Spar-TECH liquids hold 24 hours, Bt and seaweed change nothing', () => {
    expect(ruleOf('The Andersons 17-0-3 Fertilizer with Grubout Plus')).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_same_day: true });
    for (const name of ['LESCO Spar-TECH Micro Mix', 'LESCO Spar-TECH 13-0-0']) {
      expect(ruleOf(name)).toMatchObject({ mode: 'hold', hold_hours: 24, label_minimum: { hold_until: 'dry' }, label_best_results: true });
    }
    for (const name of ['Thuricide BT Caterpillar Control', 'Blue Planet Nutrients Liquid Seaweed .3-.2-1']) expect(ruleOf(name)).toMatchObject({ mode: 'none' });
    expect(item('The Andersons 17-0-3 Fertilizer with Grubout Plus').fields.moa_group.value).toBe('Group 3A + 4A');
    expect(item('Thuricide BT Caterpillar Control').fields.moa_group.value).toBe('Group 11A');
  });
});

describe(`${NAME} migration (fake knex)`, () => {
  test('fills the rule, approval and copy, one audit row per write; a second run changes nothing', async () => {
    const knex = fakeKnex({ rows: [open('LESCO Spar-TECH 13-0-0'), open('Thuricide BT Caterpillar Control')] });
    await migration.up(knex);
    expect(JSON.parse(stored(knex, 'LESCO Spar-TECH 13-0-0').post_application_watering)).toEqual(ruleOf('LESCO Spar-TECH 13-0-0'));
    expect(stored(knex, 'Thuricide BT Caterpillar Control')).toMatchObject({ approved_for_service_report: true, moa_group: 'Group 11A' });
    expect(recordAuditEvent).toHaveBeenCalledTimes(11); // 5 fields + 6 fields
    const snapshot = JSON.stringify(knex.table);
    recordAuditEvent.mockClear();
    await migration.up(knex);
    expect(JSON.stringify(knex.table)).toBe(snapshot);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('values an admin already set stand; other products are untouched', async () => {
    const admin = JSON.stringify({ mode: 'none', source: 'owner', label_note: 'Admin.' });
    const other = open('Merit 2F');
    const knex = fakeKnex({ rows: [open('LESCO Spar-TECH Micro Mix', { post_application_watering: admin, reentry_summary: 'Custom.' }), other] });
    await migration.up(knex);
    expect(stored(knex, 'LESCO Spar-TECH Micro Mix')).toMatchObject({ post_application_watering: admin, reentry_summary: 'Custom.', approved_for_service_report: true });
    expect(recordAuditEvent.mock.calls.map(([e]) => e.metadata.column).sort()).toEqual(['approved_for_service_report', 'customer_precaution_summary', 'service_report_summary']);
    expect(stored(knex, 'Merit 2F')).toEqual(other);
  });

  test('a missing column is skipped; a missing table or audit_log does not fail; down is a no-op', async () => {
    const noMoa = fakeKnex({ rows: [open('Thuricide BT Caterpillar Control')], columns: COLUMNS.filter((c) => c !== 'moa_group') });
    await migration.up(noMoa);
    expect(stored(noMoa, 'Thuricide BT Caterpillar Control')).toMatchObject({ approved_for_service_report: true, moa_group: null });
    recordAuditEvent.mockClear();
    const noAudit = fakeKnex({ rows: [open('Blue Planet Nutrients Liquid Seaweed .3-.2-1')], tables: ['products_catalog'] });
    await migration.up(noAudit);
    expect(stored(noAudit, 'Blue Planet Nutrients Liquid Seaweed .3-.2-1').approved_for_service_report).toBe(true);
    expect(recordAuditEvent).not.toHaveBeenCalled();
    await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
    const snapshot = JSON.stringify(noAudit.table);
    await migration.down(noAudit);
    expect(JSON.stringify(noAudit.table)).toBe(snapshot);
  });
});
