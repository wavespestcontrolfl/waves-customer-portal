/**
 * 20260730160000 roach catalog cleanup (owner directive 2026-07-30, follow-up
 * to #3078): rename cockroach_control to the estimate's customer-facing name
 * and archive the two never-booked pest_initial_*_knockdown rows. Both
 * directions are drift-guarded — admin edits in the Service Library beat the
 * migration on re-run and on rollback.
 */
const migration = require('../models/migrations/20260730160000_roach_catalog_rename_archive');

const LIVE = { is_active: true, is_archived: false, booking_enabled: true, customer_visible: true };
const ARCHIVED = { is_active: false, is_archived: true, booking_enabled: false, customer_visible: false };

function serviceRow(service_key, name, short_name, flags = LIVE) {
  return { service_key, name, short_name, ...flags, updated_at: 'orig' };
}

function shippedRows() {
  return [
    serviceRow('cockroach_control', 'Cockroach Control Service', 'Cockroach Control'),
    serviceRow('pest_initial_palmetto_knockdown', 'Initial Native Roach Knockdown Service', null),
    serviceRow('pest_initial_german_knockdown', 'Initial German Roach Knockdown Service', null),
    serviceRow('general_pest', 'General Pest Control', 'General Pest'),
  ];
}

function fakeKnex(rows, { hasServicesTable = true } = {}) {
  const matches = (row, cond) => Object.entries(cond).every(([k, v]) => row[k] === v);
  const knex = (table) => {
    expect(table).toBe('services');
    const filters = [];
    let inClause = null;
    const rowMatch = (r) => (
      (!inClause || inClause.vals.includes(r[inClause.col]))
      && filters.every((c) => matches(r, c))
    );
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, vals) { inClause = { col, vals }; return q; },
      first: async () => rows.find(rowMatch),
      update: async (patch) => {
        const hits = rows.filter(rowMatch);
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => (t === 'services' ? hasServicesTable : false) };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const byKey = (rows, key) => rows.find((r) => r.service_key === key);

describe('20260730160000 roach catalog rename + archive', () => {
  test('up() renames cockroach_control and archives both knockdown rows', async () => {
    const rows = shippedRows();
    await migration.up(fakeKnex(rows));

    const renamed = byKey(rows, 'cockroach_control');
    expect(renamed.name).toBe('Cockroach Treatment');
    expect(renamed.short_name).toBe('Cockroach Treatment');
    expect(renamed.updated_at).toBe('NOW');

    for (const key of ['pest_initial_palmetto_knockdown', 'pest_initial_german_knockdown']) {
      const row = byKey(rows, key);
      expect(row).toMatchObject(ARCHIVED);
      expect(row.updated_at).toBe('NOW');
      // Archive never renames — descriptions/history keep the original label.
      expect(row.name).toMatch(/Knockdown Service$/);
    }
    // Unrelated rows untouched.
    expect(byKey(rows, 'general_pest')).toMatchObject({ name: 'General Pest Control', ...LIVE, updated_at: 'orig' });
  });

  test('up() drift guards: admin rename and admin archive both win', async () => {
    const rows = shippedRows();
    byKey(rows, 'cockroach_control').name = 'Adam Custom Roach Service';
    Object.assign(byKey(rows, 'pest_initial_german_knockdown'), { is_active: false });

    await migration.up(fakeKnex(rows));

    // Admin-edited name preserved; untouched short_name still renamed.
    expect(byKey(rows, 'cockroach_control').name).toBe('Adam Custom Roach Service');
    expect(byKey(rows, 'cockroach_control').short_name).toBe('Cockroach Treatment');
    // A row the admin already deactivated is left exactly as they set it
    // (is_archived stays false — up() must not adopt it for down()).
    expect(byKey(rows, 'pest_initial_german_knockdown')).toMatchObject({ is_active: false, is_archived: false, updated_at: 'orig' });
    // The still-live sibling archives normally.
    expect(byKey(rows, 'pest_initial_palmetto_knockdown')).toMatchObject(ARCHIVED);
  });

  test('down() restores shipped values only where up() still owns them', async () => {
    const rows = shippedRows();
    const knex = fakeKnex(rows);
    await migration.up(knex);
    await migration.down(knex);

    expect(byKey(rows, 'cockroach_control')).toMatchObject({
      name: 'Cockroach Control Service',
      short_name: 'Cockroach Control',
    });
    for (const key of ['pest_initial_palmetto_knockdown', 'pest_initial_german_knockdown']) {
      expect(byKey(rows, key)).toMatchObject(LIVE);
    }
  });

  test('down() leaves post-migration admin edits alone', async () => {
    const rows = shippedRows();
    const knex = fakeKnex(rows);
    await migration.up(knex);

    // After the migration ran, the admin renamed the service again and
    // deliberately re-activated one knockdown row (partially — not the exact
    // archived state up() wrote).
    byKey(rows, 'cockroach_control').name = 'Roach Rescue';
    Object.assign(byKey(rows, 'pest_initial_palmetto_knockdown'), { is_active: true });

    await migration.down(knex);

    // Admin rename survives; the untouched short_name still rolls back.
    expect(byKey(rows, 'cockroach_control').name).toBe('Roach Rescue');
    expect(byKey(rows, 'cockroach_control').short_name).toBe('Cockroach Control');
    // The admin-modified row is not in the archived state down() owns — left
    // exactly as the admin set it.
    expect(byKey(rows, 'pest_initial_palmetto_knockdown')).toMatchObject({ is_active: true, is_archived: true });
    // The untouched sibling restores fully.
    expect(byKey(rows, 'pest_initial_german_knockdown')).toMatchObject(LIVE);
  });

  test('up() and down() no-op when the services table is absent', async () => {
    const rows = shippedRows();
    const knex = fakeKnex(rows, { hasServicesTable: false });
    await migration.up(knex);
    await migration.down(knex);
    expect(byKey(rows, 'cockroach_control').name).toBe('Cockroach Control Service');
    expect(byKey(rows, 'pest_initial_palmetto_knockdown')).toMatchObject(LIVE);
  });
});
