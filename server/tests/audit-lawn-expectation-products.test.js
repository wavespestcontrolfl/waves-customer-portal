// Read-only product-name audit for the lawn expectations table (P10).
// Synthetic fixture list and a fake knex; no database.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  auditLawnExpectationProducts,
  loadLawnProductNames,
  parseNamesFile,
  formatReport,
} = require('../scripts/audit-lawn-expectation-products');

const FIXTURE = [
  { name: 'LESCO K-Flow 0-0-25', uses: 41 },
  { name: 'Atticus Talak', uses: 33 },
  { name: 'Celsius WG', uses: 23 },
  { name: 'celsius wg ', uses: 2 }, // same product, different case and spacing
  { name: 'Primo Maxx', uses: 4 },
  { name: 'Brand New Herbicide', uses: 1 },
  { name: 'Acelepryn Xtra', uses: 3 },
  { name: '   ', uses: 9 },
];

describe('auditLawnExpectationProducts', () => {
  const result = auditLawnExpectationProducts(FIXTURE);
  const byName = Object.fromEntries(result.rows.map((r) => [r.name.toLowerCase(), r]));

  it('reports mapped, explicit null and UNMAPPED, merging case and spacing variants', () => {
    expect(byName['lesco k-flow 0-0-25']).toMatchObject({ status: 'mapped', family: 'potassium_feed' });
    expect(byName['celsius wg']).toMatchObject({ status: 'mapped', family: 'herbicide_celsius', uses: 25 });
    expect(byName['acelepryn xtra']).toMatchObject({ status: 'mapped', modeLock: 'preventive' });
    expect(byName['primo maxx']).toMatchObject({ status: 'explicit_null', family: null });
    expect(byName['brand new herbicide']).toMatchObject({ status: 'unmapped', family: null });
    expect(result.counts).toEqual({ mapped: 4, explicit_null: 1, unmapped: 1 });
    expect(result.unmapped).toEqual(['Brand New Herbicide']);
  });

  it('skips blank names and sorts by use count', () => {
    expect(result.rows).toHaveLength(6);
    expect(result.rows[0].name).toBe('LESCO K-Flow 0-0-25');
    const uses = result.rows.map((r) => r.uses);
    expect(uses).toEqual([...uses].sort((a, b) => b - a));
  });

  it('prints one line per name with its status', () => {
    const text = formatReport(result);
    expect(text).toContain('UNMAPPED 1');
    expect(text).toMatch(/UNMAPPED\s+Brand New Herbicide/);
    expect(text).toMatch(/EXPLICIT_NULL\s+Primo Maxx/);
    expect(text).toMatch(/MAPPED\s+herbicide_celsius\s+Celsius WG/);
  });

  it('an empty list is a clean empty audit', () => {
    expect(auditLawnExpectationProducts([])).toEqual({
      rows: [], counts: { mapped: 0, explicit_null: 0, unmapped: 0 }, unmapped: [],
    });
  });
});

describe('parseNamesFile', () => {
  it('reads one name per line with an optional tab-separated count', () => {
    const file = path.join(os.tmpdir(), `lawn-names-${process.pid}.txt`);
    fs.writeFileSync(file, 'Celsius WG\t5\n\nPrimo Maxx\nSomething Else\t2\n');
    try {
      expect(parseNamesFile(fs.readFileSync(file, 'utf8'))).toEqual([
        { name: 'Celsius WG', uses: 5 },
        { name: 'Primo Maxx', uses: 1 },
        { name: 'Something Else', uses: 2 },
      ]);
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('loadLawnProductNames', () => {
  it('runs one parameterized SELECT inside a READ ONLY transaction and never writes', async () => {
    const calls = [];
    const trx = {
      raw: jest.fn(async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [{ name: 'Celsius WG', uses: 23 }] };
      }),
    };
    const db = { transaction: jest.fn(async (fn, opts) => fn(trx, opts)) };
    const rows = await loadLawnProductNames(db, { sinceDays: 30 });
    expect(rows).toEqual([{ name: 'Celsius WG', uses: 23 }]);
    expect(db.transaction.mock.calls[0][1]).toEqual({ readOnly: true });
    expect(calls[0].sql).toMatch(/READ ONLY/);
    expect(calls[1].sql).toMatch(/^\s*SELECT/);
    expect(calls[1].sql).toMatch(/service_line = 'lawn'/);
    expect(calls[1].params).toEqual([30]);
    const writes = calls.filter((c) => /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i.test(c.sql));
    expect(writes).toEqual([]);
  });
});

describe('connection handling', () => {
  it('requiring the engine, the config and the audit script never loads models/db.js or knexfile.js', () => {
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => { throw new Error('models/db.js must not be loaded'); });
      jest.doMock('../knexfile', () => { throw new Error('knexfile.js must not be loaded'); });
      expect(() => {
        require('../config/lawn-expectations');
        require('../services/service-report/lawn-expectations');
        require('../scripts/audit-lawn-expectation-products');
      }).not.toThrow();
      const loaded = Object.keys(require.cache).filter((k) => /models[\\/]db\.js$|knexfile\.js$/.test(k));
      expect(loaded).toEqual([]);
    });
  });

  it('main builds its own connection from --database-url, ahead of DATABASE_URL', async () => {
    const trx = { raw: jest.fn(async (sql) => (/^\s*SELECT/.test(sql) ? { rows: [{ name: 'Celsius WG', uses: 1 }] } : {})) };
    const instance = {
      transaction: jest.fn(async (fn) => fn(trx)),
      destroy: jest.fn(async () => {}),
    };
    const knexFactory = jest.fn(() => instance);
    let main;
    jest.isolateModules(() => {
      jest.doMock('knex', () => knexFactory);
      jest.doMock('../models/db', () => { throw new Error('models/db.js must not be loaded'); });
      ({ main } = require('../scripts/audit-lawn-expectation-products'));
    });
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await main(['--database-url', 'postgres://flag-host/flagdb'], { DATABASE_URL: 'postgres://env-host/envdb' });
    } finally {
      log.mockRestore();
    }
    expect(knexFactory).toHaveBeenCalledTimes(1);
    expect(knexFactory.mock.calls[0][0].connection.connectionString).toBe('postgres://flag-host/flagdb');
    expect(instance.destroy).toHaveBeenCalled();
  });

  it('falls back to DATABASE_URL, and refuses to run with no database at all', async () => {
    const { createAuditKnex } = require('../scripts/audit-lawn-expectation-products');
    expect(() => createAuditKnex('')).toThrow(/No database/);
    expect(() => createAuditKnex('undefined')).toThrow(/No database/);
    const { main } = require('../scripts/audit-lawn-expectation-products');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(main([], {})).rejects.toThrow(/No database/);
    } finally {
      err.mockRestore();
    }
  });
});
