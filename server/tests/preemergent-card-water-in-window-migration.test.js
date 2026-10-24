// Lawn report product cards: the Stonewall 15-0-15 and Dimension 18-0-10 precaution asks for ½ inch within 14 days,
// as the watering rule 20261009200000 gave both products, instead of "within 24 hours".
const SKIP = !process.env.DATABASE_URL;
const describeDb = SKIP ? describe.skip : describe;
const { randomUUID } = require('crypto');
const knexFactory = require('knex');
const migration = require('../models/migrations/20261025010000_preemergent_card_water_in_window');
const labelLines = require('../services/service-report/lawn-label-lines');
const { parseWaterInInches } = require('../services/service-report/lawn-water-in-rain');
const { stripFixedReentryTiming, REENTRY_SAFE_COPY } = require('../services/social-media');

// The catalog text both products carried before this migration, and their re-entry line.
const CATALOG_BEFORE = 'Granules on sidewalks or driveways are swept back into the turf. Water in with about ½ inch within 24 hours. People and pets can use the lawn once it has been watered in and the turf is dry.';
const REENTRY = 'Stay off treated areas until the product has been watered in and the turf is dry.';
const FOURTEEN_DAYS = { mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 336, source: 'label' };

describe('pre-emergent card water-in window (pure)', () => {
  const after = migration.precautionAfter(CATALOG_BEFORE);

  test('only the water-in sentence changes', () => {
    expect(after).toBe('Granules on sidewalks or driveways are swept back into the turf. Water in with about ½ inch within 14 days; rain and your regular watering both count. People and pets can use the lawn once it has been watered in and the turf is dry.');
    expect(migration.precautionAfter(`Admin note first. ${CATALOG_BEFORE}`)).toBe(`Admin note first. ${after}`);
  });

  test('a text without the sentence, or with it twice, is left alone', () => {
    expect(migration.precautionAfter('Watering-in follows the visit notes.')).toBeNull();
    expect(migration.precautionAfter(`${migration.OLD_SENTENCE} ${migration.OLD_SENTENCE}`)).toBeNull();
    expect(migration.precautionAfter(null)).toBeNull();
  });

  test('the card drops the same sentence as before (the frozen decision stores indexes)', () => {
    expect(labelLines.splitSentences(after)).toHaveLength(labelLines.splitSentences(CATALOG_BEFORE).length);
    const before = labelLines.precautionDrops({ precaution: CATALOG_BEFORE, reentry: REENTRY, reentryHours: 0 });
    expect(before).toEqual([2]);
    expect(labelLines.precautionDrops({ precaution: after, reentry: REENTRY, reentryHours: 0 })).toEqual(before);
    expect(labelLines.precautionAfterDrops(after, before)).toBe('Granules on sidewalks or driveways are swept back into the turf. Water in with about ½ inch within 14 days; rain and your regular watering both count.');
  });

  test('the rain check still reads ½ inch, and the PDF compliance sweep keeps the sentence', () => {
    expect(parseWaterInInches(after)).toBe(0.5);
    expect(stripFixedReentryTiming(after, REENTRY_SAFE_COPY)).toEqual({ text: after, changed: false });
  });

  test('only the 14-day rule counts', () => {
    expect(migration.isFourteenDayRule(FOURTEEN_DAYS)).toBe(true);
    expect(migration.isFourteenDayRule({ ...FOURTEEN_DAYS, water_in_by_hours: 24 })).toBe(false);
    expect(migration.isFourteenDayRule({ ...FOURTEEN_DAYS, water_in_inches: 0.25 })).toBe(false);
    expect(migration.isFourteenDayRule({ mode: 'hold', hold_hours: 24 })).toBe(false);
    expect(migration.isFourteenDayRule(null)).toBe(false);
  });
});

describeDb('20261025010000 pre-emergent card water-in window', () => {
  let knex;
  let schema;

  beforeEach(async () => {
    schema = `preem_card_${randomUUID().replace(/-/g, '')}`;
    knex = knexFactory({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 4 } });
    await knex.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['products_catalog', 'audit_log']) {
      await knex.raw(`CREATE TABLE ??.${table} (LIKE public.${table} INCLUDING ALL)`, [schema]);
    }
  });

  afterEach(async () => {
    await knex.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await knex.destroy();
  });

  const insert = async (row) => {
    const [created] = await knex('products_catalog').insert({ id: randomUUID(), ...row }).returning('id');
    return created.id;
  };
  const text = async (id) => (await knex('products_catalog').where({ id }).first()).customer_precaution_summary;

  test('the 14-day products change once, audited; a 24-hour rule, an edited text and other products stay', async () => {
    const [stonewall, dimension] = migration.PRODUCTS;
    const edited = `${CATALOG_BEFORE} Sweep the patio too.`;
    const sw = await insert({ name: stonewall, customer_precaution_summary: edited, post_application_watering: JSON.stringify(FOURTEEN_DAYS) });
    const back = { ...FOURTEEN_DAYS, water_in_by_hours: 24, source: 'owner' };
    const dim = await insert({ name: dimension, customer_precaution_summary: CATALOG_BEFORE, post_application_watering: JSON.stringify(back) });
    const other = await insert({ name: 'Another Pre-Emergent', customer_precaution_summary: CATALOG_BEFORE, post_application_watering: JSON.stringify(FOURTEEN_DAYS) });

    await migration.up(knex);
    await migration.up(knex); // idempotent
    expect(await text(sw)).toBe(`${migration.precautionAfter(CATALOG_BEFORE)} Sweep the patio too.`);
    expect(await text(dim)).toBe(CATALOG_BEFORE);
    expect(await text(other)).toBe(CATALOG_BEFORE);
    const audits = await knex('audit_log').where('action', 'like', 'migration:20261025010000_%');
    expect(audits.map((a) => a.resource_id)).toEqual([sw]);

    await migration.down(knex);
    expect(await text(sw)).toBe(`${migration.precautionAfter(CATALOG_BEFORE)} Sweep the patio too.`);
  });
});
