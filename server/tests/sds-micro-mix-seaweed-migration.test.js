// LESCO Spar-TECH Micro Mix and Blue Planet Liquid Seaweed get the safety data sheets their sellers sent
// (owner 2026-10-29, "do all these"). No database: a small fake knex.
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { recordAuditEvent } = require('../services/audit-log');
const migration = require('../models/migrations/20261104221500_sds_micro_mix_seaweed');

const LABELS_DIR = path.join(__dirname, '../../client/public/labels');
const COLUMNS = ['id', 'name', 'sds_url', 'updated_at'];
const [MICRO_MIX, SEAWEED] = migration.ITEMS.map((i) => i.name);

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
// The rows as production holds them: no SDS link.
const open = (name, extra = {}) => ({ id: `id-${name.slice(0, 8)}`, name, sds_url: null, ...extra });

beforeEach(() => {
  recordAuditEvent.mockReset();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test('each link is an absolute portal link to a PDF this repo ships in client/public/labels', () => {
  expect(migration.ITEMS).toHaveLength(2);
  for (const item of migration.ITEMS) {
    expect(item.url).toBe(`https://portal.wavespestcontrol.com/labels/${item.file}`);
    expect(item.file).toMatch(/^[a-z0-9-]+-sds\.pdf$/);
    const bytes = fs.readFileSync(path.join(LABELS_DIR, item.file));
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(10000);
    expect(bytes.length).toBeLessThan(1024 * 1024);
  }
});

test('both empty rows get their link, one audit row each; a second run writes nothing; actions fit varchar(96)', async () => {
  const knex = fakeKnex({ rows: [open(MICRO_MIX), open(SEAWEED)] });
  await migration.up(knex);
  expect(knex.table[0]).toMatchObject({ sds_url: migration.ITEMS[0].url, updated_at: 'now()' });
  expect(knex.table[1]).toMatchObject({ sds_url: migration.ITEMS[1].url, updated_at: 'now()' });
  expect(recordAuditEvent).toHaveBeenCalledTimes(2);
  for (const [event] of recordAuditEvent.mock.calls) {
    expect(event).toMatchObject({ resource_type: 'products_catalog', critical: true, metadata: { column: 'sds_url', before: null } });
    expect(event.action).toBe(`migration:${migration.MIGRATION}:sds_url`);
    expect(event.action.length).toBeLessThanOrEqual(96);
    expect(event.metadata.sheet).toMatch(/SDS/);
  }
  recordAuditEvent.mockClear();
  await migration.up(knex);
  expect(recordAuditEvent).not.toHaveBeenCalled();
});

test('an SDS link an admin set stands, and the other row still fills', async () => {
  const knex = fakeKnex({ rows: [open(MICRO_MIX, { sds_url: 'https://example.invalid/admin.pdf' }), open(SEAWEED)] });
  await migration.up(knex);
  expect(knex.table[0].sds_url).toBe('https://example.invalid/admin.pdf');
  expect(knex.table[0]).not.toHaveProperty('updated_at');
  expect(knex.table[1].sds_url).toBe(migration.ITEMS[1].url);
  expect(recordAuditEvent).toHaveBeenCalledTimes(1);
  expect(recordAuditEvent.mock.calls[0][0].metadata.product).toBe(SEAWEED);
});

test('no row, no table, no sds_url column or no audit_log does not fail; down is a no-op', async () => {
  await expect(migration.up(fakeKnex({ rows: [] }))).resolves.toBeUndefined();
  await expect(migration.up(fakeKnex({ rows: [], tables: [] }))).resolves.toBeUndefined();
  const noColumn = fakeKnex({ rows: [{ id: 'x', name: MICRO_MIX }], columns: COLUMNS.filter((c) => c !== 'sds_url') });
  await migration.up(noColumn);
  expect(noColumn.table[0]).not.toHaveProperty('sds_url');
  const noAudit = fakeKnex({ rows: [open(SEAWEED)], tables: ['products_catalog'] });
  await migration.up(noAudit);
  expect(noAudit.table[0].sds_url).toBe(migration.ITEMS[1].url);
  expect(recordAuditEvent).not.toHaveBeenCalled();
  const snapshot = JSON.stringify(noAudit.table);
  await migration.down(noAudit);
  expect(JSON.stringify(noAudit.table)).toBe(snapshot);
});
