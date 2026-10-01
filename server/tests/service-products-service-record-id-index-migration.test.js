const migration = require('../models/migrations/20260930200000_service_products_service_record_id_index');

const knexWith = ({ table = true, column = true } = {}) => {
  const raw = jest.fn().mockResolvedValue();
  return {
    raw,
    schema: { hasTable: jest.fn().mockResolvedValue(table), hasColumn: jest.fn().mockResolvedValue(column) },
  };
};

describe('service_products.service_record_id index migration', () => {
  test('up creates a plain, idempotent index on service_record_id', async () => {
    const knex = knexWith();
    await migration.up(knex);
    expect(knex.raw).toHaveBeenCalledTimes(1);
    const sql = knex.raw.mock.calls[0][0];
    expect(sql).toBe('CREATE INDEX IF NOT EXISTS service_products_service_record_id_idx ON service_products (service_record_id)');
    expect(sql).not.toMatch(/CONCURRENTLY/); // migrations run inside a transaction
  });
  test('up is a no-op when the table or the column is missing', async () => {
    for (const opts of [{ table: false }, { column: false }]) {
      const knex = knexWith(opts);
      await migration.up(knex);
      expect(knex.raw).not.toHaveBeenCalled();
    }
  });
  test('down drops the index if it exists', async () => {
    const knex = knexWith();
    await migration.down(knex);
    expect(knex.raw).toHaveBeenCalledWith('DROP INDEX IF EXISTS service_products_service_record_id_idx');
  });
  test('no earlier migration already indexes service_products.service_record_id', () => {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', 'models', 'migrations');
    const hits = fs.readdirSync(dir).filter((f) => f.endsWith('.js') && f !== '20260930200000_service_products_service_record_id_index.js')
      .filter((f) => /(?:CREATE\s+(?:UNIQUE\s+)?INDEX[^;]*ON\s+service_products\b)/i.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    expect(hits).toEqual([]);
  });
});
