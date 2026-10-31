// Eleven in-stock lawn products approved for service reports (owner 2026-10-28, "APPROVE"), so their label-checked
// watering rules (20261027190000) reach the watering text. No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261028190000_lawn_report_approvals_in_stock_11');
const labelPass = require('../models/migrations/20261027190000_watering_rule_lawn_label_pass_2');
const { approvedReportProductFacts } = require('../services/service-report/report-data');

const NAME = '20261028190000_lawn_report_approvals_in_stock_11';
const REPORT_COLUMNS = ['approved_for_service_report', 'service_report_summary', 'customer_precaution_summary', 'reentry_summary', 'moa_group'];
const ALL_COLUMNS = ['id', 'name', ...REPORT_COLUMNS, 'updated_at'];
// The three pesticides' catalog identity (EPA numbers on their labels); report facts need a valid one.
const CATALOG = {
  'Quali-Pro T-Nex Plant Growth Regulator': { category: 'pgr', epa_reg_number: '53883-353' },
  'ALOFT LC G INSECTICIDE': { category: 'insecticide', epa_reg_number: '59639-215' },
  'Talstar XTRA Granular Insecticide (Verge)': { category: 'insecticide', epa_reg_number: '101563-388' },
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

describe('the eleven approvals (pure)', () => {
  test('eleven products, each with report copy and the approval, and a stored rule from the label pass', () => {
    expect(names).toHaveLength(11);
    expect(new Set(names).size).toBe(11);
    const ruled = new Set(labelPass.FILL.map((f) => f.name));
    for (const { name, fields } of migration.ITEMS) {
      expect(ruled.has(name)).toBe(true);
      expect(fields.approved_for_service_report).toEqual({ when: 'false', value: true });
      for (const column of ['service_report_summary', 'customer_precaution_summary', 'reentry_summary']) {
        expect({ name, column, value: fields[column].value }).toMatchObject({ name, column, value: expect.stringMatching(/\S/) });
        expect(fields[column].when).toBe('null');
      }
    }
  });

  test('copy names no chemical in a sentence (owner 2026-10-08) and reuses the approved re-entry lines', () => {
    const chemicals = /bifenthrin|clothianidin|zeta|cypermethrin|trinexapac|urea|humic|chelat(ed)? iron/i;
    for (const { fields } of migration.ITEMS) {
      for (const column of ['service_report_summary', 'customer_precaution_summary', 'reentry_summary']) {
        expect(fields[column].value).not.toMatch(chemicals);
      }
    }
    const reentries = new Set(migration.ITEMS.map((i) => i.fields.reentry_summary.value));
    expect([...reentries].sort()).toEqual([
      'Stay off treated areas until the application has dried.',
      'Stay off treated areas until the dust from the application has settled.',
      'Stay off treated areas until the product has been watered in and the turf is dry.',
      'Water in per the visit notes; no re-entry wait once dry.',
    ]);
  });

  test('mode-of-action groups only on the two insecticides', () => {
    const moa = Object.fromEntries(migration.ITEMS.filter((i) => i.fields.moa_group).map((i) => [i.name, i.fields.moa_group.value]));
    expect(moa).toEqual({ 'ALOFT LC G INSECTICIDE': 'Group 3A + 4A', 'Talstar XTRA Granular Insecticide (Verge)': 'Group 3A' });
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
  test('approves and fills the empty copy, one audit row per write', async () => {
    const knex = fakeKnex({ rows: [open('ALOFT LC G INSECTICIDE'), open('Bloom City Clean Kelp')] });
    await migration.up(knex);

    const aloft = migration.ITEMS.find((i) => i.name === 'ALOFT LC G INSECTICIDE').fields;
    expect(stored(knex, 'ALOFT LC G INSECTICIDE')).toMatchObject({
      approved_for_service_report: true,
      service_report_summary: aloft.service_report_summary.value,
      customer_precaution_summary: 'Per the product label: keep children and pets out of treated areas until the dust from the application has settled.',
      reentry_summary: 'Stay off treated areas until the dust from the application has settled.',
      moa_group: 'Group 3A + 4A',
    });
    expect(stored(knex, 'Bloom City Clean Kelp')).toMatchObject({ approved_for_service_report: true, moa_group: null });
    expect(recordAuditEvent).toHaveBeenCalledTimes(9); // ALOFT 5 + kelp 4
    const approval = recordAuditEvent.mock.calls.map(([e]) => e)
      .find((e) => e.metadata.product === 'ALOFT LC G INSECTICIDE' && e.metadata.column === 'approved_for_service_report');
    expect(approval).toMatchObject({
      actor_type: 'system', resource_type: 'products_catalog', critical: true, trx: knex,
      action: `migration:${NAME}:approved_for_service_report`,
      metadata: { migration: NAME, column: 'approved_for_service_report', before: false, after: true },
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

  test('copy an admin already wrote stands; only the empty fields are filled', async () => {
    const knex = fakeKnex({ rows: [open('Quali-Pro T-Nex Plant Growth Regulator', { reentry_summary: 'Custom re-entry.' })] });
    await migration.up(knex);
    expect(stored(knex, 'Quali-Pro T-Nex Plant Growth Regulator')).toMatchObject({ approved_for_service_report: true, reentry_summary: 'Custom re-entry.' });
    expect(recordAuditEvent).toHaveBeenCalledTimes(3); // approval + summary + precaution
  });

  test('a product already approved is not audited for approval; other products are untouched', async () => {
    const other = open('Merit 2F');
    const knex = fakeKnex({ rows: [open('The Andersons Humic DG', { approved_for_service_report: true }), other] });
    await migration.up(knex);
    expect(recordAuditEvent.mock.calls.map(([e]) => e.action)).not.toContain(`migration:${NAME}:approved_for_service_report`);
    expect(stored(knex, 'Merit 2F')).toEqual(other);
  });

  test('a missing column is skipped; a missing table or audit_log does not fail', async () => {
    const noMoa = fakeKnex({ rows: [open('Talstar XTRA Granular Insecticide (Verge)')], columns: ALL_COLUMNS.filter((c) => c !== 'moa_group') });
    await migration.up(noMoa);
    expect(stored(noMoa, 'Talstar XTRA Granular Insecticide (Verge)')).toMatchObject({ approved_for_service_report: true, moa_group: null });

    recordAuditEvent.mockClear();
    const noAudit = fakeKnex({ rows: [open('Bloom City Clean Kelp')], tables: ['products_catalog'] });
    await migration.up(noAudit);
    expect(stored(noAudit, 'Bloom City Clean Kelp').approved_for_service_report).toBe(true);
    expect(recordAuditEvent).not.toHaveBeenCalled();

    await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
  });

  test('down is a documented no-op', async () => {
    const knex = fakeKnex({ rows: [open('Bloom City Clean Kelp')] });
    await migration.up(knex);
    const snapshot = JSON.stringify(knex.table);
    await migration.down(knex);
    expect(JSON.stringify(knex.table)).toBe(snapshot);
  });
});
