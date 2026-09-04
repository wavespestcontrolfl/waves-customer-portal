/**
 * 20260903000070 — unlink owned-sender emails. In-memory knex stand-in.
 * Pins: only rows whose sender is one of OUR addresses lose their
 * customer_id (default owned list, whole internal domain, env allowlist,
 * case-insensitive); customer-sender rows and already-unlinked rows are
 * untouched; the write is CAS on the observed customer; up() is idempotent;
 * down() restores only rows still unlinked.
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const migration = require('../models/migrations/20260903000070_unlink_owned_sender_emails');

const { STATE_KEY } = migration;

function seedDb() {
  return {
    emails: [
      { id: 'e-self', from_address: 'contact@wavespestcontrol.com', customer_id: 'c-ours' },
      { id: 'e-self-cased', from_address: 'Contact@WavesPestControl.com', customer_id: 'c-ours' },
      { id: 'e-domain', from_address: 'anyone@wavespestcontrol.com', customer_id: 'c-other' },
      { id: 'e-allowlisted', from_address: 'owner@example.net', customer_id: 'c-ours' },
      { id: 'e-customer', from_address: 'jane@example.com', customer_id: 'c-jane' },
      { id: 'e-unlinked', from_address: 'contact@wavespestcontrol.com', customer_id: null },
      { id: 'e-nofrom', from_address: null, customer_id: 'c-jane' },
    ],
    system_settings: [],
  };
}

function fakeKnex(db, { onUpdate } = {}) {
  const knex = (table) => {
    const rows = () => db[table] || [];
    const preds = [];
    const match = () => rows().filter((r) => preds.every((p) => p(r)));
    const b = {
      where(c) { preds.push((r) => Object.entries(c).every(([k, v]) => (r[k] ?? null) === v)); return b; },
      whereIn(col, vals) { preds.push((r) => vals.includes(r[col])); return b; },
      whereNotNull(col) { preds.push((r) => r[col] != null); return b; },
      whereNull(col) { preds.push((r) => r[col] == null); return b; },
      async select(...cols) { return match().map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))); },
      async first() { return match()[0] || null; },
      async update(patch, returning) {
        if (onUpdate) onUpdate(db);
        const hit = match();
        hit.forEach((r) => Object.assign(r, patch));
        return returning ? hit.map((r) => Object.fromEntries(returning.map((c) => [c, r[c]]))) : hit.length;
      },
      async insert(row) { rows().push({ ...row }); },
      async del() { const hit = match(); db[table] = rows().filter((r) => !hit.includes(r)); return hit.length; },
    };
    return b;
  };
  knex.schema = {
    hasTable: async (t) => Array.isArray(db[t]),
    hasColumn: async (t, c) => Array.isArray(db[t]) && db[t].some((r) => c in r),
  };
  return knex;
}

const linkOf = (db, id) => db.emails.find((r) => r.id === id).customer_id;
const state = (db) => JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);

describe('unlink owned-sender emails migration', () => {
  const env = { ...process.env };
  beforeEach(() => { process.env.INTERNAL_EMAIL_ALLOWLIST = 'owner@example.net'; });
  afterEach(() => { process.env = { ...env }; });

  test('up() clears customer_id only where the sender is one of our addresses', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(linkOf(db, 'e-self')).toBeNull();
    expect(linkOf(db, 'e-self-cased')).toBeNull();
    expect(linkOf(db, 'e-domain')).toBeNull();
    expect(linkOf(db, 'e-allowlisted')).toBeNull();
    expect(linkOf(db, 'e-customer')).toBe('c-jane');
    expect(linkOf(db, 'e-nofrom')).toBe('c-jane');
    expect(state(db).unlinked).toEqual({
      'c-ours': ['e-self', 'e-self-cased', 'e-allowlisted'],
      'c-other': ['e-domain'],
    });
  });

  test('a row relinked between the scan and the write is left alone (CAS) and not recorded', async () => {
    const db = seedDb();
    let moved = false;
    const knex = fakeKnex(db, {
      onUpdate: (d) => { if (!moved) { moved = true; d.emails.find((r) => r.id === 'e-self').customer_id = 'c-admin-fixed'; } },
    });
    await migration.up(knex);
    expect(linkOf(db, 'e-self')).toBe('c-admin-fixed');
    expect(state(db).unlinked['c-ours']).toEqual(['e-self-cased', 'e-allowlisted']);
  });

  test('up() is idempotent once the state row exists', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    db.emails.find((r) => r.id === 'e-self').customer_id = 'c-ours'; // an admin relinks on purpose
    await migration.up(fakeKnex(db));
    expect(linkOf(db, 'e-self')).toBe('c-ours');
    expect(db.system_settings).toHaveLength(1);
  });

  test('down() restores only rows still unlinked and drops the state row', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    db.emails.find((r) => r.id === 'e-domain').customer_id = 'c-admin-fixed';
    await migration.down(fakeKnex(db));
    expect(linkOf(db, 'e-self')).toBe('c-ours');
    expect(linkOf(db, 'e-self-cased')).toBe('c-ours');
    expect(linkOf(db, 'e-allowlisted')).toBe('c-ours');
    expect(linkOf(db, 'e-domain')).toBe('c-admin-fixed');
    expect(linkOf(db, 'e-unlinked')).toBeNull();
    expect(db.system_settings).toHaveLength(0);
  });

  test('missing table or state → no-op', async () => {
    const empty = { system_settings: [] };
    await expect(migration.up(fakeKnex(empty))).resolves.toBeUndefined();
    await expect(migration.down(fakeKnex(seedDb()))).resolves.toBeUndefined();
  });
});
