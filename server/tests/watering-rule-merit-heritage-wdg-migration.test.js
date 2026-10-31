// Merit 2F and Heritage WDG watering rules, and Heritage WDG approved for reports (owner 2026-10-27, after the
// 2026-10-26 alert "Lawn watering text not sent: Merit 2F has no watering rule"). No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261027120000_watering_rule_merit_heritage_wdg');
const { validateRule } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');
const { shortWateringText } = require('../services/service-report/lawn-watering-short-text');

const MERIT = 'Merit 2F';
const HERITAGE = 'Heritage WDG';
const ALL_COLUMNS = ['id', 'name', 'approved_for_service_report', 'post_application_watering', 'service_report_summary',
  'customer_precaution_summary', 'reentry_summary', 'moa_group', 'updated_at'];

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

const empty = (name, extra = {}) => ({
  id: `id-${name}`, name, approved_for_service_report: true, post_application_watering: null, service_report_summary: null,
  customer_precaution_summary: null, reentry_summary: null, moa_group: null, ...extra,
});
const heritageOpen = () => empty(HERITAGE, { approved_for_service_report: false });
const stored = (knex, name) => knex.table.find((r) => r.name === name);
const parsed = (value) => JSON.parse(value);

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('the two rules (pure)', () => {
  test('both pass the validator and carry a source and a note', () => {
    for (const rule of [migration.MERIT_RULE, migration.HERITAGE_WDG_RULE]) {
      expect(validateRule(rule)).toMatchObject({ valid: true });
      expect(rule.source).toBe('owner');
      expect(rule.label_note.length).toBeGreaterThan(0);
    }
  });

  test('Merit 2F: 0.25 inch within 24 hours, rain counts, the label window', () => {
    expect(migration.MERIT_RULE).toMatchObject({
      mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, rain_counts: true, label_window: 'best_results',
    });
  });

  test('Heritage WDG: hold until dry, with the two label targets (no label_window beside a same-day entry)', () => {
    const rule = migration.HERITAGE_WDG_RULE;
    expect(rule).toMatchObject({ mode: 'hold', hold_until: 'dry' });
    const [fairy, root] = rule.by_target;
    expect(fairy).toMatchObject({ match: ['fairy ring'], water_in_inches: 0.25, water_in_same_day: true });
    expect(fairy.label_window).toBeUndefined();
    expect(root).toMatchObject({ match: ['root dysfunction'], water_in_inches: 0.2, water_in_by_hours: 24, label_window: 'directs' });
  });

  test('the 2026-10-26 visit: Dimension + Merit 2F + Heritage WDG now gets one customer text', () => {
    const instruction = buildWateringInstruction({
      rules: [
        { name: 'LESCO Dimension 18-0-10', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'owner' } },
        { name: MERIT, rule: migration.MERIT_RULE },
        { name: HERITAGE, rule: migration.HERITAGE_WDG_RULE },
      ],
      completedAt: '2026-10-26T16:50:59.005Z',
      runtime: null,
      plainWhenNoSetup: true,
      labelFirst: true,
    });
    expect(instruction.state).toBe('hold_then_water_in');
    expect(shortWateringText(instruction)).toBe(
      'Let the treatment dry first. Then water about 1/4 inch by Tue 12 PM, even on an off day. Get about 1/2 inch total by Mon, Nov 9 at 11 AM. Rain and regular watering count.',
    );
  });

  test('the report copy is the approved fungicides wording', () => {
    const heritage = migration.ITEMS.find((i) => i.name === HERITAGE).fields;
    expect(heritage.service_report_summary.value).toBe(require('../models/migrations/20261023120000_lawn_catalog_report_approvals_and_identity').ITEMS[0].set.service_report_summary[1]);
    expect(heritage.reentry_summary.value).toBe('Stay off treated areas until the application has dried.');
    expect(heritage.moa_group.value).toBe('Group 11');
    expect(heritage.approved_for_service_report).toEqual({ when: 'false', value: true });
  });
});

describe('20261027120000 migration (fake knex)', () => {
  test('fills the empty fields and approves Heritage WDG, one audit row per write', async () => {
    const knex = fakeKnex({ rows: [empty(MERIT), heritageOpen()] });
    await migration.up(knex);

    expect(parsed(stored(knex, MERIT).post_application_watering)).toEqual(migration.MERIT_RULE);
    const heritage = stored(knex, HERITAGE);
    expect(parsed(heritage.post_application_watering)).toEqual(migration.HERITAGE_WDG_RULE);
    expect(heritage).toMatchObject({
      approved_for_service_report: true,
      service_report_summary: migration.FUNGICIDE_SUMMARY,
      customer_precaution_summary: 'Per the product label: keep people and pets off treated areas until the spray has dried.',
      reentry_summary: 'Stay off treated areas until the application has dried.',
      moa_group: 'Group 11',
    });
    expect(recordAuditEvent).toHaveBeenCalledTimes(7); // Merit 1 + Heritage 6
    const actions = recordAuditEvent.mock.calls.map(([e]) => e.action).sort();
    expect(actions).toEqual([
      'approved_for_service_report', 'customer_precaution_summary', 'moa_group', 'post_application_watering',
      'post_application_watering', 'reentry_summary', 'service_report_summary',
    ].map((c) => `migration:20261027120000_watering_rule_merit_heritage_wdg:${c}`));
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({ actor_type: 'system', resource_type: 'products_catalog', critical: true, trx: knex });
  });

  test('a second run changes nothing and audits nothing', async () => {
    const knex = fakeKnex({ rows: [empty(MERIT), heritageOpen()] });
    await migration.up(knex);
    const snapshot = JSON.stringify(knex.table);
    recordAuditEvent.mockClear();
    await migration.up(knex);
    expect(JSON.stringify(knex.table)).toBe(snapshot);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('fields already set (admin edits) are never overwritten; only the empty ones are filled', async () => {
    const edited = { mode: 'none', source: 'owner' };
    const knex = fakeKnex({
      rows: [
        empty(MERIT, { post_application_watering: JSON.stringify(edited) }),
        heritageOpen(),
      ],
    });
    knex.table[1].reentry_summary = 'Custom re-entry text.';
    knex.table[1].moa_group = '11';
    await migration.up(knex);

    expect(stored(knex, MERIT).post_application_watering).toBe(JSON.stringify(edited));
    const heritage = stored(knex, HERITAGE);
    expect(heritage.reentry_summary).toBe('Custom re-entry text.');
    expect(heritage.moa_group).toBe('11');
    expect(heritage.approved_for_service_report).toBe(true);
    expect(parsed(heritage.post_application_watering)).toEqual(migration.HERITAGE_WDG_RULE);
    // approval + rule + summary + precaution
    expect(recordAuditEvent).toHaveBeenCalledTimes(4);
  });

  test('an already approved Heritage WDG stays approved and is not audited for approval', async () => {
    const knex = fakeKnex({ rows: [empty(HERITAGE, { approved_for_service_report: true })] });
    await migration.up(knex);
    expect(recordAuditEvent.mock.calls.map(([e]) => e.action)).not.toContain('migration:20261027120000_watering_rule_merit_heritage_wdg:approved_for_service_report');
    expect(stored(knex, HERITAGE).approved_for_service_report).toBe(true);
    expect(parsed(stored(knex, HERITAGE).post_application_watering)).toEqual(migration.HERITAGE_WDG_RULE);
  });

  test('absent rows are a no-op; other products are untouched', async () => {
    const other = empty('Heritage G');
    const knex = fakeKnex({ rows: [other] });
    await migration.up(knex);
    expect(knex.table).toEqual([other]);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('a missing column is skipped; a missing table or audit_log does not fail', async () => {
    const noMoa = fakeKnex({ rows: [heritageOpen()], columns: ALL_COLUMNS.filter((c) => c !== 'moa_group') });
    await migration.up(noMoa);
    expect(stored(noMoa, HERITAGE)).not.toHaveProperty('moa_group', 'Group 11');
    expect(stored(noMoa, HERITAGE).approved_for_service_report).toBe(true);

    recordAuditEvent.mockClear();
    const noAudit = fakeKnex({ rows: [empty(MERIT)], tables: ['products_catalog'] });
    await migration.up(noAudit);
    expect(parsed(stored(noAudit, MERIT).post_application_watering)).toEqual(migration.MERIT_RULE);
    expect(recordAuditEvent).not.toHaveBeenCalled();

    const none = fakeKnex({ rows: [], tables: [] });
    await expect(migration.up(none)).resolves.toBeUndefined();
  });

  test('down is a documented no-op', async () => {
    const knex = fakeKnex({ rows: [empty(MERIT)] });
    await expect(migration.down(knex)).resolves.toBeUndefined();
    expect(stored(knex, MERIT).post_application_watering).toBeNull();
  });
});
