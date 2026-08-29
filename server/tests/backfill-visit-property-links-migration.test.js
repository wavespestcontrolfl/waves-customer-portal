/**
 * 20260829000050 — visit→property linkage backfill + duplicate-property
 * retirement. Fake-knex harness in the style of the 20260825000010 test.
 * Pins: exactly-one-match linking (stamped OR mirror address), ambiguity
 * left alone, terminal visits untouched, single-property customers out of
 * scope, duplicate retirement only for unreferenced label-less 'unknown'
 * same-street+ZIP rows, idempotent up(), and value-guarded down().
 */
jest.mock('../models/db', () => ({}), { virtual: false });
const { addressKey } = require('../services/customer-properties');
const migration = require('../models/migrations/20260829000050_backfill_visit_property_links');

const { STATE_KEY } = migration;

// Real-looking but fictional addresses; keys computed by the SAME helper the
// migration uses so the fixture can never drift from production normalization.
const A = { address_line1: '100 Sample Trail', address_line2: null, city: 'Bradenton', zip: '34211' };
const B = { address_line1: '110 Sample Trail', address_line2: null, city: 'Bradenton', zip: '34211' };
const P = { address_line1: '20 Duplicate Way', address_line2: null, city: 'Nokomis', zip: '34275' };
const P2 = { address_line1: '20 Duplicate Way', address_line2: null, city: 'North Venice', zip: '34275' };
const prop = (id, customer_id, addr, extra = {}) => ({
  id, customer_id, active: true, is_primary: false, label: 'Home', occupancy_type: 'owner_occupied',
  ...addr, address_key: addressKey(addr), ...extra,
});

function seedDb() {
  return {
    customers: [
      { id: 'c1', ...A },
      { id: 'c2', ...A },
      { id: 'c3', ...P },
    ],
    customer_properties: [
      prop('p1', 'c1', A, { is_primary: true, label: 'Primary' }),
      prop('p2', 'c1', B, { label: 'Rental' }),
      prop('p-single', 'c2', A, { is_primary: true }),
      prop('p3', 'c3', P, { is_primary: true, label: 'Primary' }),
      // Same street + ZIP as the primary, different city spelling, no label,
      // occupancy unknown, referenced by nothing → retire.
      prop('p4', 'c3', P2, { label: null, occupancy_type: 'unknown' }),
      // Same shape but an OPEN visit references it → keep.
      prop('p5', 'c3', { ...P2, city: 'N Venice' }, { label: null, occupancy_type: 'unknown' }),
      // Same shape, referenced ONLY by a cancelled visit → history, retire.
      prop('p6', 'c3', { ...P2, city: 'Nokomis FL' }, { label: null, occupancy_type: 'unknown' }),
    ],
    scheduled_services: [
      // stamped address = A → p1
      { id: 'v-stamped', customer_id: 'c1', status: 'pending', property_id: null, service_address_line1: A.address_line1, service_address_line2: null, service_address_city: A.city, service_address_zip: A.zip },
      // no stamp, customer mirror = A → p1
      { id: 'v-mirror', customer_id: 'c1', status: 'confirmed', property_id: null, service_address_line1: null },
      // stamped address matches nothing → untouched
      { id: 'v-nomatch', customer_id: 'c1', status: 'pending', property_id: null, service_address_line1: '999 Elsewhere Rd', service_address_city: 'Venice', service_address_zip: '34293' },
      // terminal → untouched even though it would match
      { id: 'v-done', customer_id: 'c1', status: 'completed', property_id: null, service_address_line1: A.address_line1, service_address_city: A.city, service_address_zip: A.zip },
      // already linked → untouched
      { id: 'v-linked', customer_id: 'c1', status: 'pending', property_id: 'p2', service_address_line1: B.address_line1, service_address_city: B.city, service_address_zip: B.zip },
      // legacy NULL status counts as OPEN → linked (codex r1 P1)
      { id: 'v-nullstatus', customer_id: 'c1', status: null, property_id: null, service_address_line1: A.address_line1, service_address_city: A.city, service_address_zip: A.zip },
      // partial stamp (street only, no city/ZIP) keys against the mirror's city/ZIP (codex r1 P1)
      { id: 'v-partial', customer_id: 'c1', status: 'pending', property_id: null, service_address_line1: B.address_line1, service_address_line2: null, service_address_city: null, service_address_zip: null },
      // single-property customer → out of scope
      { id: 'v-single', customer_id: 'c2', status: 'pending', property_id: null, service_address_line1: A.address_line1, service_address_city: A.city, service_address_zip: A.zip },
      // references p5 so p5 must survive leg B
      { id: 'v-ref-p5', customer_id: 'c3', status: 'pending', property_id: 'p5', service_address_line1: null },
      { id: 'v-ref-p6-cancelled', customer_id: 'c3', status: 'cancelled', property_id: 'p6', service_address_line1: null },
    ],
    estimates: [],
    system_settings: [],
  };
}

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const ins = [];
    const notIns = [];
    const rowsNow = () => db[table] || [];
    const groups = []; // grouped OR predicates from where(fn)
    const notExists = []; // subqueries from whereNotExists(fn)
    const exists = []; // subqueries from whereExists(fn)
    const TERMINAL = ['completed', 'cancelled', 'skipped', 'no_show'];
    const isOpen = (r) => r.status == null || !TERMINAL.includes(r.status);
    // Sub-builder for EXISTS/NOT EXISTS: from(table) + optional correlated
    // whereRaw('<t>.property_id = customer_properties.id') + optional
    // open-visit group + optional object filters.
    const subquery = (fn) => {
      const sub = { table: null, joinPropertyId: false, openOnly: false, filters: [] };
      const b = {
        select() { return b; },
        from(tbl) { sub.table = tbl; return b; },
        whereRaw(sql) { if (!/\.property_id = customer_properties\.id$/.test(sql)) throw new Error(`fake whereRaw: ${sql}`); sub.joinPropertyId = true; return b; },
        where(c) { if (typeof c === 'function') sub.openOnly = true; else sub.filters.push(c); return b; },
      };
      fn.call(b);
      if (!sub.table) throw new Error('fake subquery: no from()');
      return sub;
    };
    const subHit = (sub, r) => (db[sub.table] || []).some((o) => (!sub.joinPropertyId || o.property_id === r.id)
      && (!sub.openOnly || isOpen(o))
      && sub.filters.every((f) => Object.entries(f).every(([k, v]) => o[k] === v)));
    const match = (r) => filters.every((f) => Object.entries(f).every(([k, v]) => (r[k] ?? null) === v))
      && ins.every((c) => c.vals.includes(r[c.col]))
      && notIns.every((c) => !c.vals.includes(r[c.col]))
      && groups.every((g) => g(r))
      && notExists.every((sub) => !subHit(sub, r))
      && exists.every((sub) => subHit(sub, r));
    // The only grouped predicate the migration uses is the open-visit one:
    // whereNull('status').orWhereNotIn('status', TERMINAL).
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
      whereNotExists(fn) { notExists.push(subquery(fn)); return q; },
      whereExists(fn) { exists.push(subquery(fn)); return q; },
      whereIn(col, vals) { ins.push({ col, vals }); return q; },
      whereNotIn(col, vals) { notIns.push({ col, vals }); return q; },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      async select(...cols) {
        return rowsNow().filter(match).map((r) => {
          if (!cols.length) return { ...r };
          const o = {}; cols.forEach((c) => { o[c] = r[c] === undefined ? null : r[c]; }); return o;
        });
      },
      async first() { const h = rowsNow().find(match); return h ? { ...h } : undefined; },
      async update(patch) {
        const hits = rowsNow().filter(match);
        if (table === 'customer_properties' && patch.active === true) {
          // emulate customer_properties_customer_address_uniq WHERE active
          for (const h of hits) {
            const clash = rowsNow().some((o) => o !== h && o.active && o.customer_id === h.customer_id && o.address_key === h.address_key);
            if (clash) throw new Error('duplicate key value violates unique constraint "customer_properties_customer_address_uniq"');
          }
        }
        hits.forEach((r) => Object.assign(r, patch));
        return hits.length;
      },
      async del() { const hits = rowsNow().filter(match); db[table] = rowsNow().filter((r) => !hits.includes(r)); return hits.length; },
      async insert(row) { (db[table] = rowsNow()).push({ ...row }); return [1]; },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
    hasColumn: async (t, c) => t in db && !missingTables.includes(t) && (db[t].length === 0 || c in db[t][0] || ['property_id'].includes(c)),
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = async (sql) => {
    if (!/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT) \w+$/.test(String(sql))) throw new Error(`fake raw: ${sql}`);
    db.__savepoints = (db.__savepoints || []).concat(String(sql).split(' ')[0]);
  };
  return knex;
}

// Wrap a fake knex so a hook runs right after the FIRST select on `table`
// (simulates a concurrent write landing between the scan and the update).
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
  wrapped.schema = knex.schema; wrapped.fn = knex.fn; wrapped.raw = knex.raw;
  return wrapped;
}

const visit = (db, id) => db.scheduled_services.find((r) => r.id === id);
const property = (db, id) => db.customer_properties.find((r) => r.id === id);
const state = (db) => JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);

describe('20260829000050 backfill visit property links', () => {
  test('up() links open unlinked visits to the single matching property (stamp or mirror)', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBe('p1');
    expect(visit(db, 'v-mirror').property_id).toBe('p1');
    expect(visit(db, 'v-nullstatus').property_id).toBe('p1');
    expect(visit(db, 'v-partial').property_id).toBe('p2');
    expect(state(db).linked).toEqual({ 'v-stamped': 'p1', 'v-mirror': 'p1', 'v-nullstatus': 'p1', 'v-partial': 'p2' });
  });

  test('up() leaves no-match, terminal, already-linked and single-property visits alone', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-nomatch').property_id).toBeNull();
    expect(visit(db, 'v-done').property_id).toBeNull();
    expect(visit(db, 'v-linked').property_id).toBe('p2');
    expect(visit(db, 'v-single').property_id).toBeNull();
  });

  test('up() leaves an AMBIGUOUS visit alone (two properties share the stamped key)', async () => {
    const db = seedDb();
    // Second active property with the same full key as p1 — cannot exist in
    // prod (unique index) but proves the exactly-one rule is enforced.
    db.customer_properties.push(prop('p1-dup', 'c1', A, { label: 'Twin' }));
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBeNull();
    expect(visit(db, 'v-mirror').property_id).toBeNull();
    // Only the visit whose key is NOT duplicated still links.
    expect(state(db).linked).toEqual({ 'v-partial': 'p2' });
  });

  test('up() retires the unreferenced / terminal-only-referenced duplicates and keeps the live-referenced one', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    expect(property(db, 'p4').active).toBe(false);
    expect(property(db, 'p4').updated_at).toBe('NOW');
    expect(property(db, 'p5').active).toBe(true);
    expect(property(db, 'p3').active).toBe(true);
    // Terminal-only reference does not block; the cancelled visit keeps its link.
    expect(property(db, 'p6').active).toBe(false);
    expect(visit(db, 'v-ref-p6-cancelled').property_id).toBe('p6');
    expect(state(db).deactivated.sort()).toEqual(['p4', 'p6']);
  });

  test('up() link UPDATE re-validates atomically (property retired / visit moved after the scan → no link)', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    let scanned = false;
    const wrapped = (table) => {
      const q = knex(table);
      if (table === 'scheduled_services' && !scanned) {
        const sel = q.select;
        q.select = async (...cols) => { const out = await sel(...cols); scanned = true;
          // Race: a merge retires p1 and moves v-mirror to another customer.
          property(db, 'p1').active = false;
          visit(db, 'v-mirror').customer_id = 'c2';
          return out; };
      }
      return q;
    };
    wrapped.schema = knex.schema; wrapped.fn = knex.fn; wrapped.raw = knex.raw;
    await migration.up(wrapped);
    expect(visit(db, 'v-stamped').property_id).toBeNull();
    expect(visit(db, 'v-mirror').property_id).toBeNull();
    expect(visit(db, 'v-partial').property_id).toBe('p2'); // unaffected target still links
    expect(Object.keys(state(db).linked)).toEqual(['v-partial']);
  });

  test('up() retirement UPDATE re-validates atomically (open ref appearing after the scan wins)', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    // Simulate the race: the scan sees no references, but by UPDATE time an
    // open visit points at p4. The fake evaluates NOT EXISTS at update time.
    const origSelect = knex;
    let scanned = false;
    const wrapped = (table) => {
      const q = origSelect(table);
      if (table === 'scheduled_services' && !scanned) {
        const sel = q.select;
        q.select = async (...cols) => { const out = await sel(...cols); scanned = true;
          db.scheduled_services.push({ id: 'v-race', customer_id: 'c3', status: 'pending', property_id: 'p4' }); return out; };
      }
      return q;
    };
    wrapped.schema = knex.schema; wrapped.fn = knex.fn; wrapped.raw = knex.raw;
    await migration.up(wrapped);
    expect(property(db, 'p4').active).toBe(true);
    expect(state(db).deactivated).toEqual(['p6']);
  });

  test('up() does not retire the duplicate when the PRIMARY changed after the scan', async () => {
    const db = seedDb();
    const knex = withRaceAfterFirstSelect(fakeKnex(db), 'scheduled_services', () => {
      // Admin re-pointed the primary to a different address since the scan.
      Object.assign(property(db, 'p3'), { ...B, address_key: addressKey(B) });
    });
    await migration.up(knex);
    expect(property(db, 'p4').active).toBe(true);
    expect(property(db, 'p6').active).toBe(true);
    expect(state(db).deactivated).toEqual([]);
  });

  test('up() reverts a retirement when an open reference lands during the UPDATE', async () => {
    const db = seedDb();
    const base = fakeKnex(db);
    let armed = false;
    const wrapped = (t) => {
      const q = base(t);
      if (t === 'customer_properties') {
        const upd = q.update;
        q.update = async (patch) => {
          const n = await upd(patch);
          // A booking commits a reference to p4 "while" the UPDATE ran —
          // invisible to its NOT EXISTS, visible to the post-write re-check.
          if (patch.active === false && n && !armed) { armed = true; db.scheduled_services.push({ id: 'v-late', customer_id: 'c3', status: 'pending', property_id: 'p4' }); }
          return n;
        };
      }
      return q;
    };
    wrapped.schema = base.schema; wrapped.fn = base.fn; wrapped.raw = base.raw;
    await migration.up(wrapped);
    expect(property(db, 'p4').active).toBe(true);
    expect(state(db).deactivated).toEqual(['p6']);
  });

  test('down() survives a unique-index refusal on revival (savepoint) and still removes the state row', async () => {
    const db = seedDb();
    const base = fakeKnex(db);
    await migration.up(base);
    // Emulate the race the NOT EXISTS cannot see: the UPDATE itself hits the
    // unique index (concurrent equal-key insert committing mid-statement).
    const wrapped = (t) => {
      const q = base(t);
      if (t === 'customer_properties') {
        const upd = q.update;
        q.update = async (patch) => {
          if (patch.active === true) throw new Error('duplicate key value violates unique constraint "customer_properties_customer_address_uniq"');
          return upd(patch);
        };
      }
      return q;
    };
    wrapped.schema = base.schema; wrapped.fn = base.fn; wrapped.raw = base.raw;
    await expect(migration.down(wrapped)).resolves.toBeUndefined();
    expect(property(db, 'p4').active).toBe(false);
    expect(db.system_settings.find((r) => r.key === STATE_KEY)).toBeUndefined();
    expect(db.__savepoints).toEqual(expect.arrayContaining(['SAVEPOINT', 'ROLLBACK']));
  });

  test('up() does not retire a labeled, blank-labeled, or non-unknown duplicate', async () => {
    const db = seedDb();
    property(db, 'p4').label = 'Guest house';
    await migration.up(fakeKnex(db));
    expect(property(db, 'p4').active).toBe(true);
    // Non-NULL but blank is still intent (strictly-NULL rule).
    const db1 = seedDb();
    property(db1, 'p4').label = '';
    await migration.up(fakeKnex(db1));
    expect(property(db1, 'p4').active).toBe(true);
    const db2 = seedDb();
    property(db2, 'p4').occupancy_type = 'rental_investment';
    await migration.up(fakeKnex(db2));
    expect(property(db2, 'p4').active).toBe(true);
  });

  test('up() is idempotent once the state row exists', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    visit(db, 'v-stamped').property_id = null; // admin cleared it after the run
    await migration.up(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBeNull();
  });

  test('down() clears only links still carrying the written property and revives retired rows', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    visit(db, 'v-mirror').property_id = 'p2'; // admin re-pointed it since
    await migration.down(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBeNull();
    expect(visit(db, 'v-mirror').property_id).toBe('p2');
    expect(property(db, 'p4').active).toBe(true);
    expect(db.system_settings.find((r) => r.key === STATE_KEY)).toBeUndefined();
  });

  test('down() leaves a retired row retired when an equal-key active row appeared since', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    db.customer_properties.push(prop('p4-new', 'c3', P2, { label: 'Re-added by admin', occupancy_type: 'rental_investment' }));
    await expect(migration.down(fakeKnex(db))).resolves.toBeUndefined();
    expect(property(db, 'p4').active).toBe(false);
  });

  test('up()/down() are no-ops without the tables / without a state row', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db, { missingTables: ['customer_properties'] }));
    expect(db.system_settings).toEqual([]);
    await migration.down(fakeKnex(db));
    expect(visit(db, 'v-stamped').property_id).toBeNull();
  });
});
