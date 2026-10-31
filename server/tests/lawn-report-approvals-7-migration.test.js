// The last seven lawn products approved for service reports (owner 2026-10-28, "ok do the seven products"), so their
// label-checked watering rules (20261027190000) reach the watering text. No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261028200000_lawn_report_approvals_7');
const labelPass = require('../models/migrations/20261027190000_watering_rule_lawn_label_pass_2');
const inStock = require('../models/migrations/20261028190000_lawn_report_approvals_in_stock_11');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const NAME = '20261028200000_lawn_report_approvals_7';
const ALL_COLUMNS = ['id', 'name', 'approved_for_service_report', 'service_report_summary', 'customer_precaution_summary', 'reentry_summary', 'moa_group', 'updated_at'];
// The three fungicides' catalog identity, already on their rows; report facts need a valid EPA number.
const CATALOG = {
  'Azoxy 2SC Select': { category: 'fungicide', epa_reg_number: '89442-21', moa_group: 'Group 11' },
  'Insignia SC Intrinsic': { category: 'fungicide', epa_reg_number: '7969-290', moa_group: 'Group 11' },
  'LESCO Spectator T&O': { category: 'fungicide', epa_reg_number: '100-1432-10404', moa_group: 'Group 3' },
};

// A fake knex over one in-memory products_catalog table: where({..}), whereNull, where(col, val), select, update.
function fakeKnex({ rows, columns = ALL_COLUMNS, tables = ['products_catalog', 'audit_log'] }) {
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
  id: `id-${name}`, name, approved_for_service_report: false, service_report_summary: null,
  customer_precaution_summary: null, reentry_summary: null, moa_group: null, ...extra,
});
const stored = (knex, name) => knex.table.find((r) => r.name === name);
const names = migration.ITEMS.map((item) => item.name);

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('the seven approvals (pure)', () => {
  test('seven products, none approved by 20261028190000, each with a label-pass rule and report copy', () => {
    expect(names).toHaveLength(7);
    expect(new Set(names).size).toBe(7);
    const ruled = new Set(labelPass.FILL.map((f) => f.name));
    const earlier = new Set(inStock.ITEMS.map((i) => i.name));
    for (const { name, fields } of migration.ITEMS) {
      expect({ name, ruled: ruled.has(name), earlier: earlier.has(name) }).toEqual({ name, ruled: true, earlier: false });
      expect(fields.approved_for_service_report).toEqual({ when: 'false', value: true });
      for (const column of ['service_report_summary', 'customer_precaution_summary', 'reentry_summary']) {
        expect(fields[column]).toMatchObject({ when: 'null', value: expect.stringMatching(/\S/) });
      }
      expect(fields.moa_group).toBeUndefined(); // the fungicides already carry theirs
    }
  });

  test('every line but the manganese summary is the copy an approved sister product carries', () => {
    const sisterLines = new Set(inStock.ITEMS.flatMap((i) => ['service_report_summary', 'customer_precaution_summary', 'reentry_summary'].map((c) => i.fields[c].value)));
    [
      'A professional-grade fertilizer blend feeding the documented plants or turf — supporting density, color, root development, and recovery on a controlled release schedule.',
      'A fungicide that protects turf and plants from fungal disease; it is absorbed into or coats the plant tissue to stop disease organisms from establishing and spreading.',
      'Stay off treated areas until the application has dried.',
    ].forEach((line) => sisterLines.add(line));
    const fresh = migration.ITEMS.flatMap((i) => ['service_report_summary', 'customer_precaution_summary', 'reentry_summary']
      .map((c) => i.fields[c].value).filter((v) => !sisterLines.has(v)));
    expect(fresh).toEqual(['A micronutrient application supporting leaf color and healthy new growth.']);
  });

  test('approved, each product carries its label-pass rule into the report facts; unapproved, it carries nothing', () => {
    for (const { name, fields } of migration.ITEMS) {
      const rule = labelPass.FILL.find((f) => f.name === name).rule;
      const row = {
        name, category: 'fertilizer', epa_reg_number: 'N/A', ...CATALOG[name], post_application_watering: rule,
        ...Object.fromEntries(Object.entries(fields).map(([column, { value }]) => [column, value])),
      };
      const facts = approvedReportProductFacts(row);
      expect({ name, mode: facts && facts.wateringRule && facts.wateringRule.mode, source: facts && facts.wateringRule && facts.wateringRule.source })
        .toEqual({ name, mode: rule.mode, source: rule.source });
      expect(approvedReportProductFacts({ ...row, approved_for_service_report: false })).toBeNull();
    }
  });
});

describe(`${NAME} migration (fake knex)`, () => {
  test('approves and fills the empty copy, leaves the group already set, one audit row per write', async () => {
    const knex = fakeKnex({ rows: [open('LESCO Spectator T&O', { moa_group: 'Group 3' }), open('Southern Ag Manganese Sulfate')] });
    await migration.up(knex);
    expect(stored(knex, 'LESCO Spectator T&O')).toMatchObject({
      approved_for_service_report: true,
      customer_precaution_summary: 'Per the product label: keep people and pets off treated areas until sprays have dried.',
      reentry_summary: 'Stay off treated areas until the application has dried.',
      moa_group: 'Group 3',
    });
    expect(stored(knex, 'Southern Ag Manganese Sulfate')).toMatchObject({
      approved_for_service_report: true,
      service_report_summary: 'A micronutrient application supporting leaf color and healthy new growth.',
    });
    expect(recordAuditEvent).toHaveBeenCalledTimes(8); // 4 fields x 2 products
    const approval = recordAuditEvent.mock.calls.map(([e]) => e)
      .find((e) => e.metadata.product === 'LESCO Spectator T&O' && e.metadata.column === 'approved_for_service_report');
    expect(approval).toMatchObject({
      actor_type: 'system', resource_type: 'products_catalog', critical: true, trx: knex,
      action: `migration:${NAME}:approved_for_service_report`,
      metadata: { migration: NAME, before: false, after: true },
    });
  });

  test('a second run changes nothing and audits nothing', async () => {
    const knex = fakeKnex({ rows: names.map((name) => open(name)) });
    await migration.up(knex);
    expect(knex.table.every((r) => r.approved_for_service_report === true)).toBe(true);
    const snapshot = JSON.stringify(knex.table);
    recordAuditEvent.mockClear();
    await migration.up(knex);
    expect(JSON.stringify(knex.table)).toBe(snapshot);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('copy an admin already wrote stands; an approved product is not audited for approval; others untouched', async () => {
    const other = open('Merit 2F');
    const knex = fakeKnex({ rows: [open('Azoxy 2SC Select', { approved_for_service_report: true, reentry_summary: 'Custom re-entry.' }), other] });
    await migration.up(knex);
    expect(stored(knex, 'Azoxy 2SC Select')).toMatchObject({ approved_for_service_report: true, reentry_summary: 'Custom re-entry.' });
    expect(recordAuditEvent.mock.calls.map(([e]) => e.metadata.column).sort()).toEqual(['customer_precaution_summary', 'service_report_summary']);
    expect(stored(knex, 'Merit 2F')).toEqual(other);
  });

  test('a missing column is skipped; a missing table or audit_log does not fail; down is a no-op', async () => {
    const noReentry = fakeKnex({ rows: [open('Insignia SC Intrinsic')], columns: ALL_COLUMNS.filter((c) => c !== 'reentry_summary') });
    await migration.up(noReentry);
    expect(stored(noReentry, 'Insignia SC Intrinsic')).toMatchObject({ approved_for_service_report: true, reentry_summary: null });

    recordAuditEvent.mockClear();
    const noAudit = fakeKnex({ rows: [open('Insignia SC Intrinsic')], tables: ['products_catalog'] });
    await migration.up(noAudit);
    expect(stored(noAudit, 'Insignia SC Intrinsic').approved_for_service_report).toBe(true);
    expect(recordAuditEvent).not.toHaveBeenCalled();

    await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
    const snapshot = JSON.stringify(noAudit.table);
    await migration.down(noAudit);
    expect(JSON.stringify(noAudit.table)).toBe(snapshot);
  });
});
