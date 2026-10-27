// Lawn label pass 2 (owner 2026-10-27, "do this": a watering rule for every lawn product, so no customer misses a
// watering text the first time a technician logs one). 83 products with no rule or only the category guess.
// No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261027190000_watering_rule_lawn_label_pass_2');
const { validateRule, rulesForTargets } = require('../services/service-report/lawn-watering-rule');
const { buildWateringInstruction } = require('../services/service-report/lawn-watering-instruction');

const NAME = '20261027190000_watering_rule_lawn_label_pass_2';
const DIMENSION = { name: 'LESCO Dimension 18-0-10', rule: { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'owner' } };
const COMPLETED = '2026-10-28T15:00:00.000Z'; // Wed 11 AM ET
const ALL_COLUMNS = ['id', 'name', 'post_application_watering', 'mow_hold_days', 'updated_at'];

const item = (name) => migration.FILL.find((f) => f.name === name);
const ruleOf = (name) => item(name).rule;

// A fake knex over one in-memory products_catalog table: where({..}), whereNull, select, update.
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

const empty = (name, extra = {}) => ({ id: `id-${name}`, name, post_application_watering: null, mow_hold_days: null, ...extra });
const stored = (knex, name) => knex.table.find((r) => r.name === name);

beforeEach(() => recordAuditEvent.mockReset());

describe('the 83 rules (pure)', () => {
  test('one entry per product; every rule passes the validator, with a label or owner source, a note and the check stamp', () => {
    const names = migration.FILL.map((f) => f.name);
    expect(names).toHaveLength(83);
    expect(new Set(names).size).toBe(83);
    for (const { name, rule } of migration.FILL) {
      expect({ name, ...validateRule(rule) }).toMatchObject({ name, valid: true });
      expect(['label', 'owner']).toContain(rule.source);
      expect(rule.label_note.length).toBeGreaterThan(0);
      expect(rule).toMatchObject({ verified_at: '2026-10-27T00:00:00.000Z', verified_by: 'label-check-2026-10-27' });
    }
  });

  test('every rule has a product-wide mode, so a visit with no logged target still gets a text', () => {
    for (const { rule } of migration.FILL) expect(['hold', 'water_in', 'none']).toContain(rule.mode);
  });

  test('every product alone, and beside LESCO Dimension 18-0-10, builds a customer text', () => {
    const build = (rules) => buildWateringInstruction({ rules, completedAt: COMPLETED, runtime: null, plainWhenNoSetup: true, labelFirst: true });
    for (const { name, rule } of migration.FILL) {
      const base = rulesForTargets(rule, [], { labelTargets: null }).map((r) => ({ name, rule: r }));
      for (const rules of [base, [DIMENSION, ...base]]) {
        const instruction = build(rules);
        expect({ name, state: instruction.state, noClaim: instruction.noClaim || null }).toMatchObject({ name, state: expect.any(String), noClaim: null });
      }
    }
  });

  test('the 48-hour runoff advice is never a hold (owner 2026-10-05)', () => {
    for (const { rule } of migration.FILL) {
      expect(rule.hold_hours).not.toBe(48);
      for (const entry of rule.by_target || []) expect(entry.hold_hours).not.toBe(48);
    }
  });

  test('granular fertilizers, palm and landscape granules included: 0.25 inch within 24 hours', () => {
    for (const name of [
      'LESCO 8-2-12 100% Poly Plus OPTI Kieserite 4% Mg 9.26% S 0.15% B 0.05% Cu 0.15% Fe 2% Mn 0.15% Zn Palm & Tropical Ornamental Granular Fertilizer',
      'LESCO 13-0-13 60% PolyPlus Landscape',
      'LESCO 24-0-11 50% NOS 30% BIO 3% Fe MOP',
      '46-0-0 Urea Professional Fertilizer',
    ]) {
      expect(ruleOf(name)).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, source: 'owner' });
    }
  });

  test('trunk injections and liquid feeds change no watering', () => {
    for (const name of ['Arborjet NUTRIROOT 1 qt', 'Arborjet PHOSPHO-Jet Systemic Fungicide', 'Arborjet Propizol Injectable Fungicide',
      'Arborjet Palm-Jet Palm Nutrition', 'LESCO 20-20-20 Soluble', 'Cytogro Liquid Biostimulant']) {
      expect(ruleOf(name)).toMatchObject({ mode: 'none', source: 'owner' });
    }
  });

  test('post-emergent herbicides: the owner 24-hour hold above the label minimum; Atrazine keeps the label 3 days', () => {
    for (const name of ['QP MSM 60DF Turf Herbicide', 'Manor', 'Segment II Herbicide', 'Monument 75WG', 'Tribute Total WDG']) {
      expect(ruleOf(name)).toMatchObject({ mode: 'hold', hold_hours: 24, source: 'owner', label_minimum: expect.any(Object) });
    }
    expect(ruleOf('Atrazine 4L')).toMatchObject({ mode: 'hold', hold_hours: 72, then_water_in: { water_in_inches: 0.5, water_in_by_hours: 240 } });
  });

  test('pre-emergents: 0.5 inch within 14 days', () => {
    expect(ruleOf('Barricade 65WG')).toMatchObject({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'label' });
    expect(ruleOf('Envu Specticle Flo Pre-Emergent Liquid Herbicide')).toMatchObject({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'owner' });
  });

  test('spring dead spot "1/4 to 1/2 inch" stays 0.25, as the stored Headway, Headway G and Heritage G', () => {
    for (const name of ['LESCO Spectator T&O', 'Heritage TL']) {
      const entry = ruleOf(name).by_target.find((t) => t.match.includes('spring dead spot'));
      expect(entry).toMatchObject({ mode: 'water_in', water_in_inches: 0.25, water_in_by_hours: 24, water_in_same_day: true });
    }
  });

  test('mow holds only where the label gives a day count for the lawn use; Segment II (bed use here) has none', () => {
    const mow = Object.fromEntries(migration.FILL.filter((f) => f.mowHoldDays).map((f) => [f.name, f.mowHoldDays]));
    expect(mow).toEqual({ 'LESCO Crosscheck Plus': 1, 'Bifen XTS': 1, 'Monument 75WG': 2, 'T-Zone SE': 2 });
  });
});

describe(`${NAME} migration (fake knex)`, () => {
  test('fills an empty rule and an empty mow hold, one audit row per write', async () => {
    const knex = fakeKnex({ rows: [empty('Monument 75WG'), empty('Chipco Signature')] });
    await migration.up(knex);

    expect(JSON.parse(stored(knex, 'Monument 75WG').post_application_watering)).toEqual(ruleOf('Monument 75WG'));
    expect(stored(knex, 'Monument 75WG').mow_hold_days).toBe(2);
    expect(JSON.parse(stored(knex, 'Chipco Signature').post_application_watering)).toEqual(ruleOf('Chipco Signature'));
    expect(stored(knex, 'Chipco Signature').mow_hold_days).toBeNull();
    expect(recordAuditEvent.mock.calls.map(([e]) => e.action).sort()).toEqual([
      `migration:${NAME}:mow_hold_seeded`, `migration:${NAME}:seeded`, `migration:${NAME}:seeded`,
    ]);
    expect(recordAuditEvent.mock.calls[0][0]).toMatchObject({
      actor_type: 'system', resource_type: 'products_catalog', critical: true, trx: knex,
      metadata: { migration: NAME, product: 'Monument 75WG', before: null, after: ruleOf('Monument 75WG') },
    });
  });

  test('a second run changes nothing and audits nothing', async () => {
    const knex = fakeKnex({ rows: [empty('Monument 75WG'), empty('Heritage TL')] });
    await migration.up(knex);
    const snapshot = JSON.stringify(knex.table);
    recordAuditEvent.mockClear();
    await migration.up(knex);
    expect(JSON.stringify(knex.table)).toBe(snapshot);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('an admin rule or mow hold already set stands', async () => {
    const edited = JSON.stringify({ mode: 'none', source: 'owner' });
    const knex = fakeKnex({ rows: [empty('Monument 75WG', { post_application_watering: edited, mow_hold_days: 3 })] });
    await migration.up(knex);
    expect(stored(knex, 'Monument 75WG')).toMatchObject({ post_application_watering: edited, mow_hold_days: 3 });
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('other products are untouched', async () => {
    const other = empty('Merit 2F');
    const knex = fakeKnex({ rows: [other] });
    await migration.up(knex);
    expect(knex.table).toEqual([other]);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('a rule the validator rejects is never written', async () => {
    let isolated;
    jest.isolateModules(() => {
      jest.doMock('../services/service-report/lawn-watering-rule', () => ({ validateRule: () => ({ valid: false, errors: ['x'] }) }));
      isolated = require('../models/migrations/20261027190000_watering_rule_lawn_label_pass_2');
    });
    const knex = fakeKnex({ rows: [empty('Chipco Signature')] });
    await isolated.up(knex);
    expect(stored(knex, 'Chipco Signature').post_application_watering).toBeNull();
    jest.dontMock('../services/service-report/lawn-watering-rule');
  });

  test('no mow_hold_days column, no audit_log or no table: no failure', async () => {
    const noMow = fakeKnex({ rows: [empty('Monument 75WG')], columns: ALL_COLUMNS.filter((c) => c !== 'mow_hold_days') });
    await migration.up(noMow);
    expect(stored(noMow, 'Monument 75WG').mow_hold_days).toBeNull();
    expect(JSON.parse(stored(noMow, 'Monument 75WG').post_application_watering)).toEqual(ruleOf('Monument 75WG'));

    recordAuditEvent.mockClear();
    const noAudit = fakeKnex({ rows: [empty('Chipco Signature')], tables: ['products_catalog'] });
    await migration.up(noAudit);
    expect(JSON.parse(stored(noAudit, 'Chipco Signature').post_application_watering)).toEqual(ruleOf('Chipco Signature'));
    expect(recordAuditEvent).not.toHaveBeenCalled();

    await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
  });

  test('down is a documented no-op', async () => {
    const knex = fakeKnex({ rows: [empty('Monument 75WG')] });
    await migration.up(knex);
    const snapshot = JSON.stringify(knex.table);
    await migration.down(knex);
    expect(JSON.stringify(knex.table)).toBe(snapshot);
  });
});
