/**
 * residential_unit_pricing seed — pins the owner-approved dollar values
 * (2026-08-11) so a typo in the migration can never reach prod silently:
 * per-visit studio 79 / 1BR 85 / 2BR 92 / 3BR 99 / 4+ 109; quarterly and
 * bi_monthly identical; NO monthly rows; one-time = 2.2× band with a $199
 * floor; oversize threshold 2200; engine service keys verbatim.
 */

const migration = require('../models/migrations/20260828000010_residential_unit_pricing');

// Minimal knex stand-in: captures inserts (and the onConflict key they
// target), reports no existing table.
function fakeKnex() {
  const inserts = [];
  const builder = (table) => ({
    insert: (rows) => {
      const entry = { table, rows: Array.isArray(rows) ? rows : [rows], onConflict: null, ignored: false };
      inserts.push(entry);
      const thenable = {
        onConflict: (cols) => { entry.onConflict = cols; return thenable; },
        ignore: () => { entry.ignored = true; return thenable; },
        then: (resolve, reject) => Promise.resolve([]).then(resolve, reject),
      };
      return thenable;
    },
  });
  const knex = (table) => builder(table);
  knex.schema = {
    hasTable: async () => false,
    createTable: async () => {},
  };
  knex.raw = (s) => s;
  knex.fn = { now: () => new Date() };
  return { knex, inserts };
}

describe('residential_unit_pricing seed', () => {
  let rows;
  beforeAll(async () => {
    const { knex, inserts } = fakeKnex();
    await migration.up(knex);
    rows = inserts.find((i) => i.table === 'residential_unit_pricing').rows;
  });

  const price = (service, frequency, band) => rows
    .filter((r) => r.service_code === service && r.frequency === frequency && r.unit_band === band)
    .map((r) => [Number(r.initial_price), Number(r.recurring_price)])[0];

  test('recurring per-visit bands match the approved table, quarterly = bi_monthly, initial = recurring', () => {
    const APPROVED = {
      studio: 79, one_bedroom: 85, two_bedroom: 92, three_bedroom: 99, four_plus: 109,
    };
    for (const [band, dollars] of Object.entries(APPROVED)) {
      expect(price('pest', 'quarterly', band)).toEqual([dollars, dollars]);
      expect(price('pest', 'bi_monthly', band)).toEqual([dollars, dollars]);
    }
  });

  test('one-time rows carry 2.2× band with the $199 floor', () => {
    expect(price('oneTimePest', 'one_time', 'studio')).toEqual([199, 199]);
    expect(price('oneTimePest', 'one_time', 'one_bedroom')).toEqual([199, 199]);
    expect(price('oneTimePest', 'one_time', 'two_bedroom')).toEqual([202.4, 202.4]);
    expect(price('oneTimePest', 'one_time', 'three_bedroom')).toEqual([217.8, 217.8]);
    expect(price('oneTimePest', 'one_time', 'four_plus')).toEqual([239.8, 239.8]);
  });

  test('no monthly rows exist, and every row carries scope + oversize threshold', () => {
    expect(rows.some((r) => r.frequency === 'monthly')).toBe(false);
    expect(rows).toHaveLength(15); // 5 bands × (quarterly + bi_monthly + one_time)
    for (const r of rows) {
      expect(r.included_scope).toBe('interior_unit_general_pest');
      expect(r.oversize_sqft_threshold).toBe(2200);
      expect(['pest', 'oneTimePest']).toContain(r.service_code);
    }
  });

  test('seed is idempotent PER ROW: inserts every band against the composite key with onConflict().ignore()', async () => {
    // A partially seeded table (say one band already present) must still
    // receive the full set — the insert targets the unique key and lets
    // PostgreSQL skip only the rows that exist.
    const { knex, inserts } = fakeKnex();
    await migration.up(knex);
    const seed = inserts.find((i) => i.table === 'residential_unit_pricing');
    expect(seed.rows).toHaveLength(15);
    expect(seed.onConflict).toEqual(['service_code', 'frequency', 'unit_band', 'effective_date']);
    expect(seed.ignored).toBe(true);
  });

  test('audit row names THIS migration and is not swallowed', async () => {
    const { knex, inserts } = fakeKnex();
    knex.schema.hasTable = async () => true; // pricing_config_audit present
    await migration.up(knex);
    const audit = inserts.find((i) => i.table === 'pricing_config_audit');
    expect(audit.rows[0].changed_by).toBe('migration:20260828000010');
  });
});
