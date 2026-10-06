/**
 * Lawn bermuda removal, follow-up data migrations on a PostgreSQL built from migrations:
 *   20261006220000 backfills the watering rule for Recognition and Fusilade II catalog rows
 *   that did not exist when 20261006200000 ran.
 *   20261006220100 seeds lawn_pricing_v2.bermudaSuppression.cost when absent, deep-merged.
 * Every test runs in a transaction that is rolled back.
 */
const describeDb = process.env.DATABASE_URL ? describe : describe.skip;

describeDb('lawn bermuda removal config migrations (PostgreSQL)', () => {
  const db = require('../models/db');
  const wateringBackfill = require('../models/migrations/20261006220000_watering_rule_bermuda_removal_backfill');
  const watering = require('../models/migrations/20261006200000_watering_rule_bermuda_removal');
  const unitToken = require('../models/migrations/20261006220200_bermuda_fusilade_unit_token');
  const RATE_UNITS = require('../../shared/rate-units.json');
  const pricingSeed = require('../models/migrations/20261006220100_lawn_pricing_bermuda_cost_seed');
  const ROLLBACK = new Error('rollback');
  const rolledBack = (run) => db.transaction(async (trx) => { await run(trx); throw ROLLBACK; }).catch((err) => { if (err !== ROLLBACK) throw err; });
  afterAll(() => db.destroy());

  describe('20261006220000 watering backfill', () => {
    const NAMES = watering.ITEMS.map((item) => item.name);
    const row = (trx, name) => trx('products_catalog').where({ name }).first('post_application_watering');
    const parsed = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

    test('a catalog row added after 20261006200000 gets the same rule; filled rows are never touched; audited; idempotent; down is a no-op', async () => {
      await rolledBack(async (trx) => {
        // The two rows exist (20261006190400) with no rule: 200000 ran before they did.
        await trx('products_catalog').whereIn('name', NAMES).update({ post_application_watering: null });
        const audits = () => trx('audit_log').where({ action: 'migration:20261006220000_watering_rule_bermuda_removal_backfill:seeded' });
        // An admin-filled row stays as it is.
        const adminRule = { mode: 'water_in', hold_hours: 0, source: 'admin' };
        await trx('products_catalog').where({ name: NAMES[1] }).update({ post_application_watering: JSON.stringify(adminRule) });
        await wateringBackfill.up(trx);
        expect(parsed((await row(trx, NAMES[0])).post_application_watering)).toEqual(watering.RULE);
        expect(parsed((await row(trx, NAMES[0])).post_application_watering)).toMatchObject({ mode: 'hold', hold_hours: 3, source: 'owner' });
        expect(parsed((await row(trx, NAMES[1])).post_application_watering)).toEqual(adminRule);
        expect(await audits()).toHaveLength(1);
        // Idempotent: nothing more is written.
        await wateringBackfill.up(trx);
        expect(await audits()).toHaveLength(1);
        // Down changes nothing.
        await wateringBackfill.down(trx);
        expect(parsed((await row(trx, NAMES[0])).post_application_watering)).toEqual(watering.RULE);
        // The second row, empty, is filled by the same rule.
        await trx('products_catalog').where({ name: NAMES[1] }).update({ post_application_watering: null });
        await wateringBackfill.up(trx);
        expect(parsed((await row(trx, NAMES[1])).post_application_watering)).toEqual(watering.RULE);
      });
    });
  });

  describe('20261006220200 Fusilade II unit token', () => {
    const FUS = 'Fusilade II Post Emergent Liquid Herbicide';
    const REC = 'Recognition Post Emergent Herbicide';

    test('on a database built from migrations alone, both catalog rows carry unit tokens every completion accepts, so the mix records with no unit edit', async () => {
      const rows = await db('products_catalog').whereIn('name', [REC, FUS]).select('name', 'rate_unit', 'cost_unit', 'inventory_unit');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        for (const unit of [row.rate_unit, row.cost_unit, row.inventory_unit].filter(Boolean)) expect(RATE_UNITS).toContain(unit);
      }
      expect(rows.find((row) => row.name === FUS).rate_unit).toBe('fl_oz');
      expect(rows.find((row) => row.name === REC).rate_unit).toBe('oz');
    });

    test('changes only a row 190400 created and only while it is exactly "fl oz"; audited; down puts it back only while unedited; idempotent', async () => {
      await rolledBack(async (trx) => {
        const unit = async () => (await trx('products_catalog').where({ name: FUS }).first('rate_unit')).rate_unit;
        const audits = async () => (await trx('audit_log').where({ action: 'migration:20261006220200_bermuda_fusilade_unit_token:seeded' })).length;
        // The state 190400 left: 'fl oz'.
        await trx('products_catalog').where({ name: FUS }).update({ rate_unit: 'fl oz' });
        const before = await audits();
        await unitToken.up(trx);
        expect(await unit()).toBe('fl_oz');
        expect(await audits()).toBe(before + 1);
        await unitToken.up(trx);
        expect(await audits()).toBe(before + 1);
        // Down restores only what it changed.
        await unitToken.down(trx);
        expect(await unit()).toBe('fl oz');
        await unitToken.down(trx);
        expect(await unit()).toBe('fl oz');
        // An edited unit is left alone by up (an admin chose 'ml') and by a later down.
        await unitToken.up(trx);
        await trx('products_catalog').where({ name: FUS }).update({ rate_unit: 'ml' });
        await unitToken.down(trx);
        expect(await unit()).toBe('ml');
        // A row 190400 did not create is never touched: a catalog row with no seeding audit keeps 'fl oz'.
        await trx('audit_log').where({ action: 'migration:20261006190400_lawn_bermuda_removal_catalog:seeded', resource_type: 'products_catalog' }).del();
        await trx('products_catalog').where({ name: FUS }).update({ rate_unit: 'fl oz' });
        await unitToken.up(trx);
        expect(await unit()).toBe('fl oz');
      });
    });
  });

  describe('20261006220100 lawn pricing cost seed', () => {
    const CHANGELOG_SUMMARY = 'Lawn bermuda removal step cost seeded into lawn_pricing_v2 (code defaults, DB-tunable).';
    const read = async (trx) => {
      const found = await trx('pricing_config').where({ config_key: 'lawn_pricing_v2' }).first('data');
      return found ? (typeof found.data === 'string' ? JSON.parse(found.data) : found.data) : null;
    };
    const write = (trx, data) => trx('pricing_config').where({ config_key: 'lawn_pricing_v2' }).update({ data: JSON.stringify(data) });
    const ensureRow = async (trx) => {
      if (!(await trx('pricing_config').where({ config_key: 'lawn_pricing_v2' }).first('config_key'))) {
        await trx('pricing_config').insert({ config_key: 'lawn_pricing_v2', name: 'Lawn Pricing V2', category: 'lawn', sort_order: 4, data: JSON.stringify({}) });
      }
    };
    // The migration already ran on this database (it may have written its own audit row): count the delta.
    const audits = async (trx) => (await trx('pricing_config_audit').where({ config_key: 'lawn_pricing_v2', changed_by: 'migration:20261006220100' })).length;

    test('adds the cost block under bermudaSuppression and keeps every other key; audited and logged; idempotent', async () => {
      await rolledBack(async (trx) => {
        await ensureRow(trx);
        const before = { programMinimumMonthly: 0, tiers: { standard: { hidden: true } }, bermudaSuppression: { perAppBase: 15, perAppPer1000Sqft: 2 }, adminOnlyKey: { nested: [1, 2] } };
        await write(trx, before);
        const auditsBefore = await audits(trx);
        const changelogBefore = (await trx('pricing_changelog').where({ summary: CHANGELOG_SUMMARY })).length;
        await pricingSeed.up(trx);
        expect(await read(trx)).toEqual({ ...before, bermudaSuppression: { perAppBase: 15, perAppPer1000Sqft: 2, cost: pricingSeed.DEFAULT_COST } });
        expect(pricingSeed.DEFAULT_COST).toEqual({ recognitionPer1000: 2.82, fusiladePer1000: 1.61, surfactantPer1000: 0.07, mixMinutes: 10, minutesPer1000: 2.5 });
        expect(await audits(trx)).toBe(auditsBefore + 1);
        const [latest] = await trx('pricing_config_audit').where({ config_key: 'lawn_pricing_v2', changed_by: 'migration:20261006220100' }).orderBy('id', 'desc').limit(1);
        expect(JSON.parse(typeof latest.old_value === 'string' ? latest.old_value : JSON.stringify(latest.old_value))).toEqual(before);
        // One changelog entry exists (the migration's own run wrote it; a repeat never adds a second).
        expect(changelogBefore + (await trx('pricing_changelog').where({ summary: CHANGELOG_SUMMARY })).length).toBeGreaterThanOrEqual(1);
        expect(await trx('pricing_changelog').where({ summary: CHANGELOG_SUMMARY })).toHaveLength(1);
        // Idempotent: a second up writes nothing.
        await pricingSeed.up(trx);
        expect(await audits(trx)).toBe(auditsBefore + 1);
      });
    });

    test('a row with no bermudaSuppression key gets one holding only the cost; an admin-edited cost block is left alone', async () => {
      await rolledBack(async (trx) => {
        await ensureRow(trx);
        await write(trx, { tiers: {} });
        await pricingSeed.up(trx);
        expect(await read(trx)).toEqual({ tiers: {}, bermudaSuppression: { cost: pricingSeed.DEFAULT_COST } });
        const edited = { bermudaSuppression: { cost: { recognitionPer1000: 3.82 } } };
        await write(trx, edited);
        await pricingSeed.up(trx);
        expect(await read(trx)).toEqual(edited);
      });
    });

    test('no lawn_pricing_v2 row: nothing is written', async () => {
      await rolledBack(async (trx) => {
        await trx('pricing_config').where({ config_key: 'lawn_pricing_v2' }).del();
        const auditsBefore = await audits(trx);
        await pricingSeed.up(trx);
        expect(await read(trx)).toBeNull();
        expect(await audits(trx)).toBe(auditsBefore);
      });
    });

    test('down removes the cost key only while it still equals the defaults', async () => {
      await rolledBack(async (trx) => {
        await ensureRow(trx);
        await write(trx, { bermudaSuppression: { perAppBase: 15 } });
        await pricingSeed.up(trx);
        await pricingSeed.down(trx);
        expect(await read(trx)).toEqual({ bermudaSuppression: { perAppBase: 15 } });
        // An edited block stays.
        const edited = { bermudaSuppression: { perAppBase: 15, cost: { ...pricingSeed.DEFAULT_COST, mixMinutes: 20 } } };
        await write(trx, edited);
        await pricingSeed.down(trx);
        expect(await read(trx)).toEqual(edited);
      });
    });
  });
});
