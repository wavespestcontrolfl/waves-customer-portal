/**
 * 20261010160000: rolling back the area add-on catalog keeps a service, completion profile or tax row an operator edited.
 * The frozen 20261008200000 down() deletes an unreferenced service by id whatever its fields, and a profile or tax row by its
 * insertion marker; the frozen 20261008220000 down() resets the web sweep's closeout source while its marker is there. The real
 * migrations run here against a small in-memory knex: the five that touch these rows go up, then a rollback runs the guard's
 * down() and the older downs in the order knex would (latest first).
 */
const catalog = require('../models/migrations/20261008200000_area_addon_catalog_rows');
const licenseMigration = require('../models/migrations/20261008210000_area_addon_license_category');
const sweepMigration = require('../models/migrations/20261008220000_area_addon_web_sweep_closeout');
const taxMarkMigration = require('../models/migrations/20261008240000_area_addon_catalog_tax_mark');
const notesMigration = require('../models/migrations/20261010130000_area_addon_catalog_notes_fix');
const guard = require('../models/migrations/20261010160000_area_addon_catalog_rollback_guard');
const sweepGuard = require('../models/migrations/20261010180000_area_addon_web_sweep_edit_guard');

const T0 = new Date('2026-10-08T12:00:00Z');
const SERVICE_COLUMNS = ['id', 'service_key', 'closeout_requirements_source', 'requires_service_report', 'requires_application_log', 'required_photo_count', 'requires_customer_signature', 'requires_customer_notice'];
const isNull = (v) => v === null || v === undefined;

// A tiny in-memory knex: where (object, column + value, builder function), whereIn, whereNull, orWhereIn, first, insert
// (+ returning), update, del, pluck, columnInfo and schema.hasTable / hasColumn.
function fakeKnex(db) {
  let seq = 0;
  const knex = (table) => {
    const rows = () => db[table];
    const preds = [];
    const group = (fn) => {
      const steps = [];
      const api = {
        whereNull(col) { steps.push(['and', (r) => isNull(r[col])]); return api; },
        orWhereIn(col, list) { steps.push(['or', (r) => list.includes(r[col])]); return api; },
      };
      fn(api);
      return (r) => steps.reduce((acc, [op, test], i) => (i === 0 ? test(r) : op === 'or' ? acc || test(r) : acc && test(r)), true);
    };
    const test = (r) => preds.every((p) => p(r));
    const q = {
      where(a, b) {
        if (typeof a === 'function') preds.push(group(a));
        else if (typeof a === 'string') preds.push((r) => r[a] === b);
        else preds.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
        return q;
      },
      whereIn(col, list) { preds.push((r) => list.includes(r[col])); return q; },
      first: async () => { const hit = rows().find(test); return hit ? { ...hit } : undefined; },
      pluck: async (col) => rows().filter(test).map((r) => r[col]),
      update: async (patch) => { const hits = rows().filter(test); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      del: async () => { const before = rows().length; db[table] = rows().filter((r) => !test(r)); return before - db[table].length; },
      columnInfo: async () => Object.fromEntries(SERVICE_COLUMNS.map((c) => [c, {}])),
      insert(row) {
        const made = { id: `${table}-${++seq}`, ...(table === 'services' ? { closeout_requirements_source: 'inferred_v1', requires_service_report: true, requires_application_log: true, required_photo_count: 0, requires_customer_signature: false, requires_customer_notice: true, license_category: null, created_at: T0, updated_at: T0 } : {}), ...row };
        const done = Promise.resolve().then(() => { db[table].push(made); });
        const out = { returning: async () => { await done; return [{ id: made.id }]; }, then: (res, rej) => done.then(res, rej) };
        return out;
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => Object.prototype.hasOwnProperty.call(db, t),
    hasColumn: async () => true,
  };
  knex.fn = { now: () => T0 };
  return knex;
}

const emptyDb = () => ({ services: [], service_completion_profiles: [], service_taxability: [], system_settings: [] });
const KEYS = catalog.SERVICES.map((s) => s.service_key);
const CHEMICAL = 'area_addon_lawn_insect_spot';
const SWEEP = 'area_addon_web_sweep';

async function seededDb() {
  const db = emptyDb();
  const knex = fakeKnex(db);
  await catalog.up(knex);
  await licenseMigration.up(knex);
  await sweepMigration.up(knex);
  await taxMarkMigration.up(knex);
  await notesMigration.up(knex);
  return db;
}
async function rollBack(db) {
  const knex = fakeKnex(db);
  await guard.down(knex);
  await notesMigration.down(knex);
  await taxMarkMigration.down(knex);
  await sweepMigration.down(knex);
  await licenseMigration.down(knex);
  await catalog.down(knex);
}
const rowOf = (db, table, key) => db[table].find((r) => r.service_key === key);
const keysLeft = (db, table) => db[table].map((r) => r.service_key).filter((k) => KEYS.includes(k)).sort();

describe('area add-on catalog rollback guard', () => {
  test('the seed leaves rows the guard reads as unedited, and up changes nothing', async () => {
    const db = await seededDb();
    await guard.up(fakeKnex(db));
    expect(db.services).toHaveLength(6);
    for (const raw of catalog.SERVICES) {
      expect(guard.serviceEdited(rowOf(db, 'services', raw.service_key), raw)).toBe(false);
      expect(guard.profileEdited(rowOf(db, 'service_completion_profiles', raw.service_key), raw)).toBe(false);
      expect(guard.taxabilityEdited(rowOf(db, 'service_taxability', raw.service_key), raw)).toBe(false);
    }
  });

  test('an unedited seed rolls back completely', async () => {
    const db = await seededDb();
    await rollBack(db);
    expect(db.services).toEqual([]);
    expect(db.service_completion_profiles).toEqual([]);
    expect(db.service_taxability).toEqual([]);
    expect(db.system_settings).toEqual([]);
  });

  test.each([
    ['price', { base_price: 109 }],
    ['name', { name: 'Lawn Insect Spot Treatment (office)' }],
    ['short name', { short_name: 'Spot' }],
    ['description', { description: 'Edited text' }],
    ['duration', { default_duration_minutes: 45 }],
    ['sort order', { sort_order: 12 }],
    ['internal notes', { internal_notes: 'Office note' }],
    ['icon', { icon: '🔥' }],
    ['active flag', { is_active: false }],
    ['customer visibility', { customer_visible: false }],
    ['booking switch', { booking_enabled: true }],
    ['license rule', { requires_license: false }],
    ['license category', { license_category: 'GHP' }],
    ['tax mark', { is_taxable: true }],
    ['closeout rules (the source an edit stamps)', { requires_application_log: false, closeout_requirements_source: 'manual' }],
    ['a column the migrations did not write (stamped by the Service Library save)', { frequency: 'annual', updated_at: new Date('2026-10-09T09:00:00Z') }],
  ])('a service whose %s an operator edited survives the rollback with its profile and tax row, and the others are deleted', async (_field, edit) => {
    const db = await seededDb();
    Object.assign(rowOf(db, 'services', CHEMICAL), edit);
    await rollBack(db);
    expect(keysLeft(db, 'services')).toEqual([CHEMICAL]);
    expect(keysLeft(db, 'service_completion_profiles')).toEqual([CHEMICAL]);
    expect(keysLeft(db, 'service_taxability')).toEqual([CHEMICAL]);
    expect(rowOf(db, 'services', CHEMICAL)).toMatchObject(edit);
  });

  test.each([
    ['delivery mode', 'service_completion_profiles', { delivery_mode: 'internal_only' }],
    ['completion mode', 'service_completion_profiles', { completion_mode: 'project' }],
    ['follow-up policy', 'service_completion_profiles', { followup_policy: 'schedule' }],
    ['residential tax', 'service_taxability', { residential_taxable: true }],
    ['tax category', 'service_taxability', { tax_category: 'other' }],
    ['tax label', 'service_taxability', { service_label: 'Renamed' }],
  ])('a profile or tax row whose %s an operator edited keeps the service and both rows', async (_field, table, edit) => {
    const db = await seededDb();
    Object.assign(rowOf(db, table, CHEMICAL), edit);
    await rollBack(db);
    expect(keysLeft(db, 'services')).toEqual([CHEMICAL]);
    expect(keysLeft(db, 'service_completion_profiles')).toEqual([CHEMICAL]);
    expect(keysLeft(db, 'service_taxability')).toEqual([CHEMICAL]);
    expect(rowOf(db, table, CHEMICAL)).toMatchObject(edit);
  });

  describe('the web sweep closeout rules', () => {
    test('an operator edit that kept the marker (the form echoes it) is marked manual, the rules stay, and the row survives', async () => {
      const db = await seededDb();
      expect(rowOf(db, 'services', SWEEP).closeout_requirements_source).toBe(sweepMigration.SOURCE_MARKER);
      rowOf(db, 'services', SWEEP).requires_application_log = true;
      await rollBack(db);
      expect(keysLeft(db, 'services')).toEqual([SWEEP]);
      expect(rowOf(db, 'services', SWEEP)).toMatchObject({ requires_application_log: true, requires_service_report: true, closeout_requirements_source: 'manual' });
    });

    test('an edit that already stamped manual is left to the older down(), and the row survives', async () => {
      const db = await seededDb();
      Object.assign(rowOf(db, 'services', SWEEP), { required_photo_count: 2, closeout_requirements_source: 'manual' });
      await rollBack(db);
      expect(rowOf(db, 'services', SWEEP)).toMatchObject({ required_photo_count: 2, closeout_requirements_source: 'manual' });
    });

    test('an unedited sweep is deleted with the rest, and a price edit keeps the row but still resets the unedited closeout source', async () => {
      const db = await seededDb();
      rowOf(db, 'services', SWEEP).base_price = 99;
      await rollBack(db);
      expect(keysLeft(db, 'services')).toEqual([SWEEP]);
      expect(rowOf(db, 'services', SWEEP).closeout_requirements_source).toBe('inferred_v1');
    });
  });

  test('two edited keys are both kept; the state row is gone after the older down()', async () => {
    const db = await seededDb();
    rowOf(db, 'services', CHEMICAL).base_price = 89;
    rowOf(db, 'service_taxability', 'area_addon_fire_ant_yard').residential_taxable = true;
    await rollBack(db);
    expect(keysLeft(db, 'services')).toEqual(['area_addon_fire_ant_yard', CHEMICAL].sort());
    expect(db.system_settings).toEqual([]);
  });

  test('missing tables and a missing state row skip without error', async () => {
    await expect(guard.down(fakeKnex({}))).resolves.toBeUndefined();
    await expect(guard.down(fakeKnex({ services: [], system_settings: [] }))).resolves.toBeUndefined();
  });
});

// Codex round 18 P2: the 20261010160000 guard cannot see a web sweep edit to a field no migration wrote, because it does not
// read the web sweep's updated_at (two migrations stamp it). 20261010180000 compares it with the finish time of the last
// migration that writes the row, and keeps the row whenever that time cannot be read.
describe('web sweep edit guard (20261010180000)', () => {
  const FINISHED = new Date(T0.getTime() + 1500); // a migration finishes just after it stamps updated_at
  const withMigrationRows = (db, rows = sweepGuard.WRITER_MIGRATIONS) => {
    db.knex_migrations = rows.map((name) => ({ name, migration_time: FINISHED }));
    return db;
  };
  const rollBackAll = async (db) => {
    const knex = fakeKnex(db);
    await sweepGuard.down(knex);
    await guard.down(knex);
    await notesMigration.down(knex);
    await taxMarkMigration.down(knex);
    await sweepMigration.down(knex);
    await licenseMigration.down(knex);
    await catalog.down(knex);
  };
  const LATER = new Date('2026-10-09T09:00:00Z');

  test('it only reads: up() changes nothing, and an unedited web sweep still rolls back with the rest', async () => {
    const db = withMigrationRows(await seededDb());
    await sweepGuard.up(fakeKnex(db));
    expect(db.services).toHaveLength(6);
    await rollBackAll(db);
    expect(db.services).toEqual([]);
    expect(db.service_completion_profiles).toEqual([]);
    expect(db.service_taxability).toEqual([]);
    expect(db.system_settings).toEqual([]);
  });

  test('the older guard alone misses an edit to an unseeded field (the case this guard exists for)', async () => {
    const db = await seededDb();
    Object.assign(rowOf(db, 'services', SWEEP), { frequency: 'annual', updated_at: LATER });
    await rollBack(db);
    expect(keysLeft(db, 'services')).toEqual([]);
  });

  test.each([
    ['frequency', { frequency: 'annual' }],
    ['description', { description: 'Edited text' }],
    ['a save that changed nothing the migrations wrote', {}],
  ])('a web sweep saved after the migrations (%s) survives with its profile and tax row, and the other five are deleted', async (_field, edit) => {
    const db = withMigrationRows(await seededDb());
    Object.assign(rowOf(db, 'services', SWEEP), { ...edit, updated_at: LATER });
    await rollBackAll(db);
    expect(keysLeft(db, 'services')).toEqual([SWEEP]);
    expect(keysLeft(db, 'service_completion_profiles')).toEqual([SWEEP]);
    expect(keysLeft(db, 'service_taxability')).toEqual([SWEEP]);
    expect(rowOf(db, 'services', SWEEP)).toMatchObject(edit);
  });

  test('a save within the clock-skew window of the last migration is not told from the migration\'s own write', async () => {
    const db = withMigrationRows(await seededDb());
    rowOf(db, 'services', SWEEP).updated_at = new Date(FINISHED.getTime() + 3000);
    await rollBackAll(db);
    expect(keysLeft(db, 'services')).toEqual([]);
  });

  test.each([
    ['no knex_migrations table', (db) => db],
    ['no row for one of the three migrations', (db) => withMigrationRows(db, sweepGuard.WRITER_MIGRATIONS.slice(0, 2))],
    ['an unreadable migration_time', (db) => { withMigrationRows(db).knex_migrations[0].migration_time = 'not a date'; return db; }],
    ['no updated_at on the web sweep', (db) => { withMigrationRows(db); rowOf(db, 'services', SWEEP).updated_at = null; return db; }],
  ])('%s: the service is kept (when in doubt, keep the operator\'s row)', async (_case, shape) => {
    const db = shape(await seededDb());
    await rollBackAll(db);
    expect(keysLeft(db, 'services')).toEqual([SWEEP]);
  });

  test('an unseeded-field edit AND an edit the older guard catches: both survive; missing tables and state skip without error', async () => {
    const db = withMigrationRows(await seededDb());
    Object.assign(rowOf(db, 'services', SWEEP), { frequency: 'annual', updated_at: LATER });
    rowOf(db, 'services', CHEMICAL).base_price = 89;
    await rollBackAll(db);
    expect(keysLeft(db, 'services')).toEqual([CHEMICAL, SWEEP].sort());
    await expect(sweepGuard.down(fakeKnex({}))).resolves.toBeUndefined();
    await expect(sweepGuard.down(fakeKnex({ services: [], system_settings: [] }))).resolves.toBeUndefined();
  });
});
