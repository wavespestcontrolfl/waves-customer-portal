/**
 * Two earlier Sequestar correction migrations were pushed and recorded by preview databases, so their filenames must stay.
 * Both are now documented no-ops; 20261023140000 does the correction. A stub that touches the database would run on every
 * environment that has not yet recorded it.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '../models/migrations');
const FILES = [
  '20261023010000_sequestar_clear_wrong_per_1000_default',
  '20261023120000_sequestar_per_1000_default_correction',
];

describe('superseded Sequestar migrations', () => {
  test.each(FILES)('%s loads and does nothing', async (name) => {
    const migration = require(path.join(DIR, name));
    expect(typeof migration.up).toBe('function');
    expect(typeof migration.down).toBe('function');
    const knex = new Proxy(() => { throw new Error('knex touched'); }, {
      get() { throw new Error('knex touched'); },
    });
    await expect(migration.up(knex)).resolves.toBeUndefined();
    await expect(migration.down(knex)).resolves.toBeUndefined();
  });

  test.each(FILES)('%s names the migration that replaced it and holds no query code', (name) => {
    const source = fs.readFileSync(path.join(DIR, `${name}.js`), 'utf8');
    expect(source).toContain('20261023140000_sequestar_per_1000_default_correction_v2');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/knex|require\(/);
  });
});
