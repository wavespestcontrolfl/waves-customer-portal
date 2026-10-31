/**
 * Territories by ZIP, build 1 + 2 (owner 2026-10-30 "go"): the territory_zips seed,
 * the ZIP lookup, the blank-ZIP backfill rules and the ZIP a web-form lead saves.
 * No database: a fake knex for the migration and the lookup, source guards for
 * the lead webhook (house style, see attribution-capture-wiring.test.js).
 */
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());

const migration = require('../models/migrations/20261031000000_territory_zips');
const { AREA_SLUGS } = require('../config/territory-areas');
const { normalizeZip, territoryForZip } = require('../services/territory');
const { plannedLeadZip, plannedCustomerZip } = require('../scripts/backfill-blank-zip');

const { AREA_ZIPS, seedRows } = migration._private;

describe('territory_zips seed', () => {
  const rows = seedRows();

  test('52 service ZIPs, each in exactly one area', () => {
    const zips = rows.map((row) => row.zip);
    expect(zips).toHaveLength(52);
    expect(new Set(zips).size).toBe(52);
    for (const zip of zips) expect(zip).toMatch(/^\d{5}$/);
  });

  test('the seeded areas are exactly the configured areas', () => {
    expect(Object.keys(AREA_ZIPS).sort()).toEqual([...AREA_SLUGS].sort());
  });

  test('the Manatee River splits north from the Ranch', () => {
    expect(AREA_ZIPS.north_river).toEqual(['34219', '34221', '34222', '34250']);
    expect(AREA_ZIPS.ranch).toEqual(expect.arrayContaining(['34202', '34211', '34212']));
  });

  test('every seeded row starts with no technician', () => {
    for (const row of rows) expect(row.technician_id).toBeUndefined();
  });
});

describe('migration up/down', () => {
  function fakeKnex({ hasTable = false } = {}) {
    const calls = { created: null, columns: [], inserted: null, conflict: null, dropped: null };
    const column = (name, extra = {}) => {
      const col = { name, ...extra };
      calls.columns.push(col);
      const chain = {
        primary: () => { col.primary = true; return chain; },
        notNullable: () => { col.nullable = false; return chain; },
        nullable: () => { col.nullable = true; return chain; },
        references: (ref) => { col.references = ref; return chain; },
        inTable: (table) => { col.inTable = table; return chain; },
        onDelete: (mode) => { col.onDelete = mode; return chain; },
        defaultTo: (value) => { col.defaultTo = value; return chain; },
      };
      return chain;
    };
    const table = {
      string: (name, length) => column(name, { type: 'string', length }),
      uuid: (name) => column(name, { type: 'uuid' }),
      timestamp: (name) => column(name, { type: 'timestamp' }),
      index: jest.fn(),
    };
    const knex = jest.fn(() => ({
      insert: (payload) => {
        calls.inserted = payload;
        return { onConflict: (col) => ({ ignore: async () => { calls.conflict = col; } }) };
      },
    }));
    knex.fn = { now: () => 'now()' };
    knex.schema = {
      hasTable: async () => hasTable,
      createTable: async (name, build) => { calls.created = name; build(table); },
      dropTableIfExists: async (name) => { calls.dropped = name; },
    };
    knex.calls = calls;
    return knex;
  }

  test('creates the table with a SET NULL technician key, then seeds without overwriting', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex.calls.created).toBe('territory_zips');
    const zip = knex.calls.columns.find((col) => col.name === 'zip');
    expect(zip).toMatchObject({ length: 5, primary: true });
    const tech = knex.calls.columns.find((col) => col.name === 'technician_id');
    expect(tech).toMatchObject({ nullable: true, references: 'id', inTable: 'technicians', onDelete: 'SET NULL' });
    expect(knex.calls.inserted).toHaveLength(52);
    expect(knex.calls.conflict).toBe('zip');
  });

  test('an existing table is not recreated; the seed still fills missing ZIPs', async () => {
    const knex = fakeKnex({ hasTable: true });
    await migration.up(knex);
    expect(knex.calls.created).toBeNull();
    expect(knex.calls.inserted).toHaveLength(52);
  });

  test('down drops the table', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    expect(knex.calls.dropped).toBe('territory_zips');
  });
});

describe('normalizeZip', () => {
  test('keeps the 5-digit ZIP of a ZIP or ZIP+4 field', () => {
    expect(normalizeZip('34219')).toBe('34219');
    expect(normalizeZip(' 34219-1234 ')).toBe('34219');
  });

  test('anything else is no ZIP', () => {
    for (const value of [null, undefined, '', '3421', '342190', 'FL 34219', '34219 FL', 34219.5]) {
      expect(normalizeZip(value)).toBeNull();
    }
  });
});

describe('territoryForZip', () => {
  function fakeDb(rows) {
    const reads = [];
    const db = jest.fn((table) => ({
      where: (filter) => ({
        first: async (...cols) => {
          reads.push({ table, filter, cols });
          return rows.find((row) => row.zip === filter.zip) || undefined;
        },
      }),
    }));
    db.reads = reads;
    return db;
  }

  test('reads the area and the territory technician', async () => {
    const db = fakeDb([{ zip: '34219', area: 'north_river', technician_id: 'tech-a' }]);
    await expect(territoryForZip(db, '34219-0001')).resolves.toEqual({
      zip: '34219', area: 'north_river', areaLabel: 'North of the river', technicianId: 'tech-a',
    });
    expect(db.reads[0]).toMatchObject({ table: 'territory_zips', filter: { zip: '34219' } });
  });

  test('a ZIP with no technician reads technicianId null', async () => {
    const db = fakeDb([{ zip: '34293', area: 'venice', technician_id: null }]);
    await expect(territoryForZip(db, '34293')).resolves.toMatchObject({ area: 'venice', technicianId: null });
  });

  test('a ZIP outside the table, or no ZIP, is null without a read for no ZIP', async () => {
    const db = fakeDb([]);
    await expect(territoryForZip(db, '90210')).resolves.toBeNull();
    await expect(territoryForZip(db, '')).resolves.toBeNull();
    expect(db.reads).toHaveLength(1);
  });
});

describe('backfill-blank-zip plan', () => {
  test('a lead takes its customer ZIP first, then a ZIP typed in its address', () => {
    expect(plannedLeadZip({ customer_zip: '34202-1111', address: '1 Main St, Venice, FL 34293' })).toBe('34202');
    expect(plannedLeadZip({ customer_zip: '', address: '87th Street East, FL 34219' })).toBe('34219');
    expect(plannedLeadZip({ customer_zip: null, address: '4512 Gulf Dr, Holmes Beach, FL 34217' })).toBe('34217');
  });

  test('a lead takes the ZIP this run recovers for its customer, before its own typed address', () => {
    const recovered = new Map([['cust-1', '34209']]);
    expect(plannedLeadZip({ customer_id: 'cust-1', customer_zip: '', address: '' }, recovered)).toBe('34209');
    expect(plannedLeadZip({ customer_id: 'cust-1', customer_zip: '', address: '1 Main St, Venice, FL 34293' }, recovered)).toBe('34209');
    expect(plannedLeadZip({ customer_id: 'cust-1', customer_zip: '34202', address: '' }, recovered)).toBe('34202');
    expect(plannedLeadZip({ customer_id: 'cust-2', customer_zip: '', address: '' }, recovered)).toBeNull();
  });

  test('no ZIP to read stays blank: no guessing from a house number', () => {
    expect(plannedLeadZip({ customer_zip: null, address: '' })).toBeNull();
    expect(plannedLeadZip({ customer_zip: null, address: '34219 Main Street' })).toBeNull();
    expect(plannedLeadZip({ customer_zip: null, address: null })).toBeNull();
  });

  test('a customer takes a ZIP typed at the end of a packed line 1', () => {
    expect(plannedCustomerZip({ address_line1: '12 Palm Ave, Bradenton, FL 34209' })).toBe('34209');
    expect(plannedCustomerZip({ address_line1: '12 Palm Ave' })).toBeNull();
  });
});

describe('lead webhook saves the typed ZIP (source guard)', () => {
  const source = fs.readFileSync(path.join(__dirname, '../routes/lead-webhook.js'), 'utf8');

  test('a new form lead stores the normalized address ZIP', () => {
    const insert = source.slice(source.indexOf("const [newLead] = await db('leads').insert({"));
    expect(insert.slice(0, 600)).toContain('zip: normalizedAddress.zip || null,');
  });

  test('attaching to a call lead adds a typed ZIP only, never a blank one', () => {
    const attach = source.slice(source.indexOf('const buildPrefillAttachFields = () => ({'));
    expect(attach.slice(0, 500)).toContain('...(normalizedAddress.zip ? { zip: normalizedAddress.zip } : {}),');
  });
});

describe('territoryReadout (build 3 read-out rows)', () => {
  const { territoryReadout } = require('../services/territory');

  test('names each area, keeps the server order and drops rows with no stops', async () => {
    const db = {
      raw: jest.fn(async () => ({
        rows: [
          { technician_id: 'tech-a', technician_name: 'Adam', area: 'north_river', booked: 12, done: 9 },
          { technician_id: 'tech-a', technician_name: 'Adam', area: null, booked: 1, done: 0 },
          { technician_id: null, technician_name: null, area: 'venice', booked: 0, done: 0 },
        ],
      })),
    };
    await expect(territoryReadout(db, { today: '2026-11-02', ahead: '2026-11-30', back: '2026-10-05' })).resolves.toEqual([
      { technicianId: 'tech-a', technicianName: 'Adam', area: 'north_river', areaLabel: 'North of the river', booked: 12, done: 9 },
      { technicianId: 'tech-a', technicianName: 'Adam', area: null, areaLabel: null, booked: 1, done: 0 },
    ]);
    // Booked counts from today on, done counts before today, inside [back, ahead).
    expect(db.raw.mock.calls[0][1]).toEqual(['2026-11-02', '2026-11-02', '2026-10-05', '2026-11-30']);
  });
});
