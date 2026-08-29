/**
 * Migration 20260829000040 — backfill pre-convention visit labels.
 * Asserts the two population contracts (cadence-mapped unlinked rows,
 * whitelist-gated linked sync with the run-time live-catalog exclusion),
 * Invariant 1 (terminal rows untouched), the fail-closed skip when a
 * mapping target is missing from the active catalog, the reminder fanout
 * (own row + same-slot sibling, component-wise on merged labels), and the
 * identity-checked CAS down() reversal.
 *
 * Purpose-built fake knex: this migration's only grouped-where callback is
 * the open-visit-status predicate, so the fake evaluates where(fn) as
 * exactly that predicate (the shared suffix-renames harness ignores
 * grouped callbacks, which would silently drop Invariant 1 here).
 */
const migration = require('../models/migrations/20260829000040_backfill_pre_convention_visit_labels');

const STATE_KEY = 'migration.20260829000040.state';
const TERMINAL = ['completed', 'cancelled', 'skipped', 'no_show'];

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (tableExpr) => {
    const table = String(tableExpr).split(' ')[0];
    const filters = [];
    let joined = null; // { table, fk } — only services-on-service_id is used
    let openOnly = false;
    let rawNeq = false; // ss.service_type <> sv.name
    let inClause = null;
    const rows = () => db[table] || [];
    const isOpen = (r) => r.status == null || !TERMINAL.includes(r.status);
    const svcById = (id) => (db.services || []).find((s) => s.id === id);
    const match = (r) => {
      if (openOnly && !isOpen(r)) return false;
      if (inClause && !inClause.vals.includes(r[inClause.col.replace(/^ss\./, '')])) return false;
      if (rawNeq) {
        const sv = svcById(r.service_id);
        if (!sv || r.service_type === sv.name) return false;
      }
      if (joined && !svcById(r.service_id)) return false;
      return filters.every((f) => Object.entries(f).every(([k, v]) => r[k.replace(/^ss\./, '')] === v));
    };
    const q = {
      join(t) { joined = { table: t }; return q; },
      where(cond) {
        if (typeof cond === 'function') { openOnly = true; return q; }
        filters.push(cond);
        return q;
      },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      whereIn(col, vals) { inClause = { col, vals }; return q; },
      whereRaw(sql) {
        if (!/service_type <> sv\.name/.test(sql)) throw new Error(`fake whereRaw: unsupported ${sql}`);
        rawNeq = true;
        return q;
      },
      async select(...cols) {
        return rows().filter(match).map((r) => {
          if (!cols.length) return { ...r };
          const out = {};
          cols.forEach((c) => {
            const [expr, , alias] = String(c).split(' ');
            const key = expr.replace(/^(ss|sv)\./, '');
            const fromJoin = expr.startsWith('sv.');
            out[alias || key] = fromJoin ? svcById(r.service_id)?.[key] : r[key];
          });
          return out;
        });
      },
      async first(...cols) { return (await q.select(...cols))[0] || null; },
      async update(payload) {
        const hit = rows().filter(match);
        hit.forEach((r) => Object.assign(r, payload));
        return hit.length;
      },
      async insert(payload) { rows().push({ ...payload }); return [1]; },
      async del() {
        const keep = rows().filter((r) => !match(r));
        const removed = rows().length - keep.length;
        db[table] = keep;
        return removed;
      },
    };
    return q;
  };
  knex.schema = { hasTable: async (t) => !missingTables.includes(t) && !!db[t] };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

function seedDb() {
  return {
    services: [
      { id: 'svc-q', name: 'Quarterly Pest Control Service', is_active: true },
      { id: 'svc-m', name: 'Monthly Pest Control Service', is_active: true },
      { id: 'svc-l6', name: 'Every 6 Weeks Lawn Care Service', is_active: true },
      { id: 'svc-sa', name: 'Semiannual Pest Control Service', is_active: true },
      // A LIVE catalog row whose name is on the linked whitelist — the
      // run-time exclusion must drop it from the sweep.
      { id: 'svc-gp', name: 'General Pest Control', is_active: true },
      // Inactive catalog names do not count as live.
      { id: 'svc-old', name: 'Pest Control Service', is_active: false },
      // NOTE: no 'Bi-Monthly Lawn Care Service' row — that mapping must skip.
    ],
    scheduled_services: [
      // Leg A hits
      { id: 'u1', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly', status: 'pending' },
      { id: 'u2', service_id: null, service_type: 'Pest Control', recurring_pattern: 'monthly', status: null },
      // wrong cadence for its label — mapping pair doesn't exist, untouched
      { id: 'u3', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'custom', status: 'pending' },
      // terminal — Invariant 1, untouched
      { id: 'u4', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly', status: 'completed' },
      // mapping whose target is missing from the catalog — fail closed
      { id: 'u5', service_id: null, service_type: 'Lawn Care Service', recurring_pattern: 'bimonthly', status: 'pending' },
      // Leg B hit: whitelist label, syncs from catalog
      { id: 'l1', service_id: 'svc-q', service_type: 'Pest Control', recurring_pattern: 'quarterly', status: 'confirmed' },
      // linkage conflict: label is a valid catalog name — NOT whitelisted, untouched
      { id: 'l2', service_id: 'svc-q', service_type: 'Semiannual Pest Control Service', recurring_pattern: 'quarterly', status: 'pending' },
      // linked, label already equals catalog name — untouched
      { id: 'l3', service_id: 'svc-m', service_type: 'Monthly Pest Control Service', recurring_pattern: 'monthly', status: 'pending' },
      // whitelisted label that is ALSO a live catalog name, contradicting
      // its service_id — linkage conflict, owner-managed, untouched
      { id: 'l4', service_id: 'svc-q', service_type: 'General Pest Control', recurring_pattern: 'quarterly', status: 'pending' },
      // whitelisted label that exists only as an INACTIVE catalog row — still stale, syncs
      { id: 'l5', service_id: 'svc-m', service_type: 'Pest Control Service', recurring_pattern: 'monthly', status: 'pending' },
    ],
    appointment_reminders: [
      // u1's own registration — plain stale label
      { id: 'r-u1', scheduled_service_id: 'u1', customer_id: 'c1', appointment_time: 'T1', service_type: 'Quarterly Pest Control', updated_at: 'orig' },
      // l1's own registration holds a MERGED label — only the component swaps
      { id: 'r-l1', scheduled_service_id: 'l1', customer_id: 'c2', appointment_time: 'T2', service_type: 'Pest Control & Mosquito Control', updated_at: 'orig' },
      // same-slot sibling of l1 (merger stored the combined label on the
      // earlier visit's row) — swept via customer_id + appointment_time
      { id: 'r-sib', scheduled_service_id: 'x-other', customer_id: 'c2', appointment_time: 'T2', service_type: 'Mosquito Control, Pest Control, and Lawn Care', updated_at: 'orig' },
      // a longer name that merely STARTS with the stale label — never matches
      { id: 'r-long', scheduled_service_id: 'l1', customer_id: 'c2', appointment_time: 'T2', service_type: 'Pest Control Premium', updated_at: 'orig' },
      // registration for an untouched (terminal) visit — untouched
      { id: 'r-u4', scheduled_service_id: 'u4', customer_id: 'c3', appointment_time: 'T3', service_type: 'Quarterly Pest Control', updated_at: 'orig' },
      // linkage-conflict visit's registration — untouched
      { id: 'r-l4', scheduled_service_id: 'l4', customer_id: 'c4', appointment_time: 'T4', service_type: 'General Pest Control', updated_at: 'orig' },
    ],
    system_settings: [],
  };
}

const byId = (db, id) => db.scheduled_services.find((r) => r.id === id);
const rem = (db, id) => db.appointment_reminders.find((r) => r.id === id);
const readState = (db) => JSON.parse(db.system_settings.find((r) => r.key === STATE_KEY).value);

describe('20260829000040 backfill up()', () => {
  test('relabels mapped unlinked + whitelisted linked open rows; honors Invariant 1, fail-closed target guard, live-catalog exclusion', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service');
    expect(byId(db, 'u2').service_type).toBe('Monthly Pest Control Service'); // NULL status is open
    expect(byId(db, 'u3').service_type).toBe('Quarterly Pest Control'); // cadence pair not mapped
    expect(byId(db, 'u4').service_type).toBe('Quarterly Pest Control'); // terminal
    expect(byId(db, 'u5').service_type).toBe('Lawn Care Service'); // target missing → skip
    expect(byId(db, 'l1').service_type).toBe('Quarterly Pest Control Service');
    expect(byId(db, 'l2').service_type).toBe('Semiannual Pest Control Service'); // linkage conflict excluded
    expect(byId(db, 'l3').service_type).toBe('Monthly Pest Control Service'); // already synced
    expect(byId(db, 'l4').service_type).toBe('General Pest Control'); // live catalog name → owner-managed
    expect(byId(db, 'l5').service_type).toBe('Monthly Pest Control Service'); // inactive row ≠ live

    const state = readState(db);
    expect(state.unlinked.map((r) => r.id).sort()).toEqual(['u1', 'u2']);
    expect(state.linked.map((r) => r.id).sort()).toEqual(['l1', 'l5']);
    // Population identity rides in the record for down().
    expect(state.unlinked.find((r) => r.id === 'u1')).toEqual(
      { id: 'u1', from: 'Quarterly Pest Control', to: 'Quarterly Pest Control Service', pattern: 'quarterly' }
    );
    expect(state.linked.find((r) => r.id === 'l1')).toEqual(
      { id: 'l1', from: 'Pest Control', to: 'Quarterly Pest Control Service', service_id: 'svc-q' }
    );
  });

  test('fans the relabel out to reminder registrations: own row, same-slot sibling, component-wise on merged labels', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control Service');
    expect(rem(db, 'r-u1').updated_at).toBe('NOW');
    expect(rem(db, 'r-l1').service_type).toBe('Quarterly Pest Control Service & Mosquito Control');
    expect(rem(db, 'r-sib').service_type).toBe('Mosquito Control, Quarterly Pest Control Service, and Lawn Care');
    expect(rem(db, 'r-long').service_type).toBe('Pest Control Premium'); // prefix-only, not a component
    expect(rem(db, 'r-u4').service_type).toBe('Quarterly Pest Control'); // terminal visit's reminder
    expect(rem(db, 'r-l4').service_type).toBe('General Pest Control'); // conflict visit's reminder

    const state = readState(db);
    expect(state.reminders.map((r) => r.id).sort()).toEqual(['r-l1', 'r-sib', 'r-u1']);
    // A sibling records the COMPONENT visit that swept it, not its own owner.
    expect(state.reminders.find((r) => r.id === 'r-sib')).toEqual({
      id: 'r-sib',
      prior: 'Mosquito Control, Pest Control, and Lawn Care',
      written: 'Mosquito Control, Quarterly Pest Control Service, and Lawn Care',
      from: 'Pest Control',
      to: 'Quarterly Pest Control Service',
      visit_id: 'l1',
    });
  });

  test('skips the reminder fanout without the appointment_reminders table', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db, { missingTables: ['appointment_reminders'] }));
    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service');
    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control');
    expect(readState(db).reminders).toEqual([]);
  });

  test('no-ops without the scheduled_services table', async () => {
    const db = seedDb();
    await expect(migration.up(fakeKnex(db, { missingTables: ['scheduled_services'] }))).resolves.toBeUndefined();
    expect(db.system_settings).toHaveLength(0);
  });
});

describe('20260829000040 down()', () => {
  test('CAS-restores recorded rows still open, unchanged, and in-population under the written label; clears state', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    // u1 completed under the NEW label after up() — down must leave it.
    byId(db, 'u1').status = 'completed';
    // l1 was hand-edited after up() — CAS mismatch, down must leave it.
    byId(db, 'l1').service_type = 'Owner Custom Label';
    // u2 was LINKED by the owner after up() — no longer the unlinked
    // population; label agrees with the link, down must leave it.
    byId(db, 'u2').service_id = 'svc-m';
    // l5 was re-linked to a different service after up() — down must leave it.
    byId(db, 'l5').service_id = 'svc-q';

    await migration.down(knex);

    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service');
    expect(byId(db, 'u2').service_type).toBe('Monthly Pest Control Service'); // linked since → kept
    expect(byId(db, 'l1').service_type).toBe('Owner Custom Label');
    expect(byId(db, 'l5').service_type).toBe('Monthly Pest Control Service'); // relinked since → kept
    expect(db.system_settings).toHaveLength(0);
  });

  test('restores an unlinked row whose cadence is unchanged, leaves one the owner re-cadenced', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    byId(db, 'u1').recurring_pattern = 'monthly'; // owner re-cadenced after up()
    await migration.down(knex);
    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service'); // identity changed → kept
    expect(byId(db, 'u2').service_type).toBe('Pest Control'); // restored
  });

  test('reverses reminder components on the CURRENT value, honoring the completed-history invariant', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    // l1 completed after up(): its reminder AND the sibling it swept keep the new component.
    byId(db, 'l1').status = 'completed';
    // r-u1 gained an add-on component since up() — component-wise reversal keeps it.
    rem(db, 'r-u1').service_type = 'Quarterly Pest Control Service & Mosquito Control';

    await migration.down(knex);

    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control & Mosquito Control');
    expect(rem(db, 'r-l1').service_type).toBe('Quarterly Pest Control Service & Mosquito Control');
    expect(rem(db, 'r-sib').service_type).toBe('Mosquito Control, Quarterly Pest Control Service, and Lawn Care');
  });

  test('down is a no-op without a state row', async () => {
    const db = seedDb();
    await expect(migration.down(fakeKnex(db))).resolves.toBeUndefined();
    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control');
    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control');
  });
});
