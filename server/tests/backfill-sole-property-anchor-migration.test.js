/**
 * 20260903000050 — sole-property anchor backfill. Fake-knex harness in the
 * style of the 20260829000050 test. Pins: exactly-one linking, stamped rows
 * and terminal rows untouched, multi-/no-property customers out of scope,
 * a property added between scan and write blocks the link (CAS), idempotent
 * up(), and value-guarded down().
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const migration = require('../models/migrations/20260903000050_backfill_sole_property_anchor');

const { STATE_KEY } = migration;

function seedDb() {
  return {
    customer_properties: [
      { id: 'p-sole', customer_id: 'c-sole', active: true },
      { id: 'p-retired', customer_id: 'c-sole', active: false }, // inactive → does not count
      { id: 'p-m1', customer_id: 'c-multi', active: true },
      { id: 'p-m2', customer_id: 'c-multi', active: true },
    ],
    scheduled_services: [
      { id: 'v-open', customer_id: 'c-sole', status: 'pending', property_id: null, service_address_line1: null, visit_id: null },
      { id: 'v-confirmed', customer_id: 'c-sole', status: 'confirmed', property_id: null, service_address_line1: null },
      { id: 'v-nullstatus', customer_id: 'c-sole', status: null, property_id: null, service_address_line1: null },
      { id: 'v-stamped', customer_id: 'c-sole', status: 'pending', property_id: null, service_address_line1: '9 Elsewhere Rd' },
      { id: 'v-done', customer_id: 'c-sole', status: 'completed', property_id: null, service_address_line1: null },
      { id: 'v-cancelled', customer_id: 'c-sole', status: 'cancelled', property_id: null, service_address_line1: null },
      { id: 'v-linked', customer_id: 'c-sole', status: 'pending', property_id: 'p-retired', service_address_line1: null },
      { id: 'v-multi', customer_id: 'c-multi', status: 'pending', property_id: null, service_address_line1: null },
      { id: 'v-noprop', customer_id: 'c-none', status: 'pending', property_id: null, service_address_line1: null },
    ],
    system_settings: [],
  };
}

function fakeKnex(db) {
  const knex = (table) => {
    const filters = [];
    const nots = [];
    const ins = [];
    const groups = [];
    const exists = [];
    const notExists = [];
    const rowsNow = () => db[table] || [];
    const TERMINAL = ['completed', 'cancelled', 'skipped', 'no_show'];
    const subquery = (fn) => {
      const sub = { table: null, filters: [], nots: [] };
      const b = {
        select() { return b; },
        from(tbl) { sub.table = tbl; return b; },
        where(c) { sub.filters.push(c); return b; },
        whereNot(col, val) { sub.nots.push({ col, val }); return b; },
      };
      fn.call(b);
      if (!sub.table) throw new Error('fake subquery: no from()');
      return sub;
    };
    const subHit = (sub) => (db[sub.table] || []).some((o) => sub.filters.every((f) => Object.entries(f).every(([k, v]) => (o[k] ?? null) === v))
      && sub.nots.every((n) => o[n.col] !== n.val));
    const match = (r) => filters.every((f) => Object.entries(f).every(([k, v]) => (r[k] ?? null) === v))
      && nots.every((n) => r[n.col] !== n.val)
      && ins.every((c) => c.vals.includes(r[c.col]))
      && groups.every((g) => g(r))
      && exists.every((sub) => subHit(sub))
      && notExists.every((sub) => !subHit(sub));
    const groupBuilder = () => {
      const g = { nulls: [], orNotIns: [] };
      const b = {
        whereNull(col) { g.nulls.push(col); return b; },
        orWhereNotIn(col, vals) { g.orNotIns.push({ col, vals }); return b; },
      };
      return { b, pred: (r) => g.nulls.some((c) => r[c] == null) || g.orNotIns.some((c) => !c.vals.includes(r[c.col])) };
    };
    const q = {
      where(cond) {
        if (typeof cond === 'function') { const { b, pred } = groupBuilder(); cond(b); groups.push(pred); return q; }
        filters.push(cond); return q;
      },
      whereNot(col, val) { nots.push({ col, val }); return q; },
      whereIn(col, vals) { ins.push({ col, vals }); return q; },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      whereExists(fn) { exists.push(subquery(fn)); return q; },
      whereNotExists(fn) { notExists.push(subquery(fn)); return q; },
      async select(...cols) {
        return rowsNow().filter(match).map((r) => {
          if (!cols.length) return { ...r };
          const o = {}; cols.forEach((c) => { o[c] = r[c] === undefined ? null : r[c]; }); return o;
        });
      },
      async first() { const h = rowsNow().find(match); return h ? { ...h } : undefined; },
      async update(patch) { const hits = rowsNow().filter(match); hits.forEach((r) => Object.assign(r, patch)); return hits.length; },
      async del() { const hits = rowsNow().filter(match); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      async insert(row) { (db[table] = rowsNow()).push({ ...row }); return [1]; },
    };
    void TERMINAL;
    return q;
  };
  knex.schema = {
    hasTable: async (t) => t in db,
    hasColumn: async (t, c) => t in db && (db[t].length === 0 || c in db[t][0]),
  };
  return knex;
}

// Hook fires right after the FIRST select on `table` (a write landing
// between the scan and the CAS update).
function withRaceAfterFirstSelect(knex, table, hook) {
  let fired = false;
  const wrapped = (t) => {
    const q = knex(t);
    if (t === table && !fired) {
      const sel = q.select;
      q.select = async (...cols) => { const out = await sel(...cols); fired = true; hook(); return out; };
    }
    return q;
  };
  wrapped.schema = knex.schema;
  return wrapped;
}

const visit = (db, id) => db.scheduled_services.find((r) => r.id === id);
const state = (db) => JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);

describe('20260903000050 backfill sole-property anchor', () => {
  test('up() stamps every open unstamped unlinked visit of a sole-property customer', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-open').property_id).toBe('p-sole');
    expect(visit(db, 'v-confirmed').property_id).toBe('p-sole');
    expect(visit(db, 'v-nullstatus').property_id).toBe('p-sole');
    expect(state(db).linked).toEqual({ 'v-open': 'p-sole', 'v-confirmed': 'p-sole', 'v-nullstatus': 'p-sole' });
  });

  test('up() leaves stamped, terminal, already-linked, multi-property and property-less rows alone', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBeNull();
    expect(visit(db, 'v-done').property_id).toBeNull();
    expect(visit(db, 'v-cancelled').property_id).toBeNull();
    expect(visit(db, 'v-linked').property_id).toBe('p-retired');
    expect(visit(db, 'v-multi').property_id).toBeNull();
    expect(visit(db, 'v-noprop').property_id).toBeNull();
  });

  test('up() is a no-op once the state row exists (idempotent)', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    visit(db, 'v-open').property_id = null; // admin cleared it since
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-open').property_id).toBeNull();
    expect(Object.keys(state(db).linked)).toHaveLength(3);
  });

  test('CAS: a second active property added between scan and write blocks the link', async () => {
    const db = seedDb();
    const knex = withRaceAfterFirstSelect(fakeKnex(db), 'scheduled_services', () => {
      db.customer_properties.push({ id: 'p-new', customer_id: 'c-sole', active: true });
    });
    await migration.up(knex);
    expect(visit(db, 'v-open').property_id).toBeNull();
    expect(visit(db, 'v-confirmed').property_id).toBeNull();
    expect(state(db).linked).toEqual({});
  });

  test('CAS: a property retired between scan and write blocks the link', async () => {
    const db = seedDb();
    const knex = withRaceAfterFirstSelect(fakeKnex(db), 'scheduled_services', () => {
      db.customer_properties.find((p) => p.id === 'p-sole').active = false;
    });
    await migration.up(knex);
    expect(visit(db, 'v-open').property_id).toBeNull();
    expect(state(db).linked).toEqual({});
  });

  test('down() clears only the links up() wrote and still holds, then drops the state row', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    visit(db, 'v-confirmed').property_id = 'p-admin'; // admin re-pointed it since
    visit(db, 'v-nullstatus').visit_id = 'vis-1'; // grouped since — the visit keys on the property
    await migration.down(fakeKnex(db));
    expect(visit(db, 'v-open').property_id).toBeNull();
    expect(visit(db, 'v-nullstatus').property_id).toBe('p-sole');
    expect(visit(db, 'v-confirmed').property_id).toBe('p-admin');
    expect(db.system_settings.find((r) => r.key === STATE_KEY)).toBeUndefined();
  });

  test('down() without a state row restores nothing', async () => {
    const db = seedDb();
    visit(db, 'v-open').property_id = 'p-sole';
    await migration.down(fakeKnex(db));
    expect(visit(db, 'v-open').property_id).toBe('p-sole');
  });

  test('up() skips a schema without property_id', async () => {
    const db = seedDb();
    db.scheduled_services = db.scheduled_services.map(({ property_id, ...r }) => r);
    await migration.up(fakeKnex(db));
    expect(db.system_settings).toEqual([]);
  });
});
