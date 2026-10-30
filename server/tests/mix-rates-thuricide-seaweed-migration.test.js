// Thuricide BT and Blue Planet Liquid Seaweed get their label mix rates per gallon (owner 2026-10-29, "do all these").
// No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261029170000_mix_rates_thuricide_seaweed');
const { _test: { perGallonRate } } = require('../services/job-card');
const RATE_UNITS = require('../../shared/rate-units.json');

const COLUMNS = ['id', 'name', 'default_rate', 'default_unit', 'dilution_rate', 'label_source_url', 'updated_at'];
const [THURICIDE, SEAWEED] = migration.ITEMS.map((i) => i.name);

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
// The rows as production holds them: the admin-insert placeholder unit, no rate, no dilution, no source page.
const open = (name, extra = {}) => ({
  id: `id-${name.slice(0, 8)}`, name, default_rate: null, default_unit: 'oz', dilution_rate: null, label_source_url: null, ...extra,
});
const columnsAudited = () => recordAuditEvent.mock.calls.map(([e]) => e.metadata.column);

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('the job card reads both rates as label per-gallon rates in fl oz, a unit the completion accepts', async () => {
  const knex = fakeKnex({ rows: [open(THURICIDE), open(SEAWEED)] });
  await migration.up(knex);
  const [thuricide, seaweed] = knex.table;
  expect(perGallonRate(thuricide)).toEqual({ lo: 0.67, hi: 0.67, unit: 'fl_oz' });
  expect(perGallonRate(seaweed)).toEqual({ lo: 0.08, hi: 0.33, unit: 'fl_oz' });
  expect(RATE_UNITS).toContain('fl_oz/gal');
  // 2 fl oz per 3 gal; ½ to 2 tsp per gal (6 tsp = 1 fl oz), rounded to 2 places.
  expect(Math.round((2 / 3) * 100) / 100).toBe(0.67);
  expect([0.5 / 6, 2 / 6].map((x) => Math.round(x * 100) / 100)).toEqual([0.08, 0.33]);
  expect(thuricide).toMatchObject({ dilution_rate: '2 fl oz/3 gal (4 tsp/gal)', label_source_url: expect.stringMatching(/^https:\/\//) });
  expect(seaweed).toMatchObject({ dilution_rate: '0.5-2 tsp/gal', label_source_url: expect.stringMatching(/^https:\/\//) });
});

test('one audit row per changed column, each quoting the label; a second run writes nothing; actions fit varchar(96)', async () => {
  const knex = fakeKnex({ rows: [open(THURICIDE), open(SEAWEED)] });
  await migration.up(knex);
  expect(recordAuditEvent).toHaveBeenCalledTimes(8);
  for (const [event] of recordAuditEvent.mock.calls) {
    expect(event).toMatchObject({ resource_type: 'products_catalog', critical: true });
    expect(event.action.length).toBeLessThanOrEqual(96);
    expect(event.metadata.label).toMatch(/per gallon/);
  }
  expect(recordAuditEvent.mock.calls.find(([e]) => e.metadata.column === 'default_unit')[0].metadata).toMatchObject({ before: 'oz', after: 'fl_oz/gal' });
  recordAuditEvent.mockClear();
  await migration.up(knex);
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('the rate and unit move only as a pair: an admin rate under oz, or another unit, leaves both alone', async () => {
  const knex = fakeKnex({ rows: [open(THURICIDE, { default_rate: '2' }), open(SEAWEED, { default_unit: 'fl_oz' })] });
  await migration.up(knex);
  expect(knex.table[0]).toMatchObject({ default_rate: '2', default_unit: 'oz' });
  expect(knex.table[1]).toMatchObject({ default_rate: null, default_unit: 'fl_oz' });
  expect(columnsAudited()).not.toContain('default_rate');
  expect(columnsAudited()).not.toContain('default_unit');
  // The fill-if-NULL fields still land.
  expect(knex.table[0].dilution_rate).toBe('2 fl oz/3 gal (4 tsp/gal)');
});

test('an admin dilution or source page stands; missing column, no row, no table or no audit_log does not fail; down is a no-op', async () => {
  const set = fakeKnex({ rows: [open(SEAWEED, { dilution_rate: 'per label', label_source_url: 'https://example.invalid/x' })] });
  await migration.up(set);
  expect(set.table[0]).toMatchObject({ dilution_rate: 'per label', label_source_url: 'https://example.invalid/x', default_unit: 'fl_oz/gal' });
  const noSource = fakeKnex({ rows: [open(SEAWEED)], columns: COLUMNS.filter((c) => c !== 'label_source_url') });
  await migration.up(noSource);
  expect(noSource.table[0]).toMatchObject({ default_rate: '0.08-0.33', dilution_rate: '0.5-2 tsp/gal' });
  await expect(migration.up(fakeKnex({ rows: [] }))).resolves.toBeUndefined();
  await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
  recordAuditEvent.mockClear();
  const noAudit = fakeKnex({ rows: [open(THURICIDE)], tables: ['products_catalog'] });
  await migration.up(noAudit);
  expect(noAudit.table[0].default_unit).toBe('fl_oz/gal');
  expect(recordAuditEvent).not.toHaveBeenCalled();
  const snapshot = JSON.stringify(noAudit.table);
  await migration.down(noAudit);
  expect(JSON.stringify(noAudit.table)).toBe(snapshot);
});
