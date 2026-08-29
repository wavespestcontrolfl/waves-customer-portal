/**
 * Migration 20260829000040 — backfill pre-convention visit labels.
 * Asserts the two population contracts (cadence-mapped unlinked rows,
 * whitelist-gated linked sync with the run-time live-catalog exclusion),
 * Invariant 1 (terminal rows untouched), the fail-closed skip when a
 * mapping target is missing from the active catalog, the snapshot fanout
 * (reminder own-row + same-slot sibling component-wise, self-booking
 * exact-or-qualified, draft/scheduled invoice title/service_type/line
 * items under the updated_at CAS with frozen statements skipped), and the
 * identity-checked CAS down() reversal under the completed-history
 * invariant for every copy.
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
    let joined = null; // { table } — only services-on-service_id is used
    let openOnly = false;
    let rawNeq = false; // ss.service_type <> sv.name
    const inClauses = [];
    const rows = () => db[table] || [];
    const isOpen = (r) => r.status == null || !TERMINAL.includes(r.status);
    const svcById = (id) => (db.services || []).find((s) => s.id === id);
    const match = (r) => {
      if (openOnly && !isOpen(r)) return false;
      for (const c of inClauses) if (!c.vals.includes(r[c.col.replace(/^ss\./, '')])) return false;
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
      whereIn(col, vals) { inClauses.push({ col, vals }); return q; },
      whereRaw(sql, bindings) {
        if (/service_type <> sv\.name/.test(sql)) { rawNeq = true; return q; }
        if (/^updated_at::text = \?$/.test(sql)) { filters.push({ updated_at: bindings[0] }); return q; }
        throw new Error(`fake whereRaw: unsupported ${sql}`);
      },
      forUpdate() { return q; },
      async select(...cols) {
        return rows().filter(match).map((r) => {
          if (!cols.length) return { ...r };
          const out = {};
          cols.forEach((c) => {
            const [expr, , alias] = String(c).split(' ');
            const key = expr.replace(/^(ss|sv)\./, '').replace(/::text$/, '');
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
  knex.raw = (sql) => sql; // only used as `updated_at::text AS updated_at_cas`
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
      { id: 'u1', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: 'sb-1' },
      { id: 'u2', service_id: null, service_type: 'Pest Control', recurring_pattern: 'monthly', status: null, self_booking_id: null },
      // wrong cadence for its label — mapping pair doesn't exist, untouched
      { id: 'u3', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'custom', status: 'pending', self_booking_id: null },
      // terminal — Invariant 1, untouched
      { id: 'u4', service_id: null, service_type: 'Quarterly Pest Control', recurring_pattern: 'quarterly', status: 'completed', self_booking_id: 'sb-4' },
      // mapping whose target is missing from the catalog — fail closed
      { id: 'u5', service_id: null, service_type: 'Lawn Care Service', recurring_pattern: 'bimonthly', status: 'pending', self_booking_id: null },
      // Leg B hit: whitelist label, syncs from catalog; shares booking sb-1 with u1
      { id: 'l1', service_id: 'svc-q', service_type: 'Pest Control', recurring_pattern: 'quarterly', status: 'confirmed', self_booking_id: 'sb-1' },
      // linkage conflict: label is a valid catalog name — NOT whitelisted, untouched
      { id: 'l2', service_id: 'svc-q', service_type: 'Semiannual Pest Control Service', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: null },
      // linked, label already equals catalog name — untouched
      { id: 'l3', service_id: 'svc-m', service_type: 'Monthly Pest Control Service', recurring_pattern: 'monthly', status: 'pending', self_booking_id: null },
      // whitelisted label that is ALSO a live catalog name, contradicting
      // its service_id — linkage conflict, owner-managed, untouched
      { id: 'l4', service_id: 'svc-q', service_type: 'General Pest Control', recurring_pattern: 'quarterly', status: 'pending', self_booking_id: null },
      // whitelisted label that exists only as an INACTIVE catalog row — still stale, syncs
      { id: 'l5', service_id: 'svc-m', service_type: 'Pest Control Service', recurring_pattern: 'monthly', status: 'pending', self_booking_id: 'sb-5' },
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
    self_booked_appointments: [
      // linked from BOTH u1 (Quarterly Pest Control → …) and l1 (Pest
      // Control → …); its label matches u1's stale name, qualifier kept
      { id: 'sb-1', service_type: 'Quarterly Pest Control (Quarterly)' },
      // linked only from terminal u4 — never in the sweep
      { id: 'sb-4', service_type: 'Quarterly Pest Control' },
      // linked from l5 but carries a label that isn't l5's stale name — untouched
      { id: 'sb-5', service_type: 'Owner Custom Booking Label' },
    ],
    invoices: [
      // draft for u1: title + service_type + one line item swap
      { id: 'i-u1', scheduled_service_id: 'u1', status: 'draft', title: 'Quarterly Pest Control — first visit', service_type: 'Quarterly Pest Control', payer_statement_id: null, updated_at: 'orig',
        line_items: JSON.stringify([{ description: 'Quarterly Pest Control', category: 'Quarterly Pest Control', amount: 100 }, { description: 'Fuel surcharge', category: 'fee', amount: 5 }]) },
      // SENT invoice for u1 — history, untouched
      { id: 'i-u1-sent', scheduled_service_id: 'u1', status: 'sent', title: 'Quarterly Pest Control', service_type: 'Quarterly Pest Control', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
      // scheduled invoice for l1 on a FROZEN payer statement — issued document, untouched
      { id: 'i-l1-frozen', scheduled_service_id: 'l1', status: 'scheduled', title: 'Pest Control', service_type: 'Pest Control', payer_statement_id: 'ps-closed', updated_at: 'orig', line_items: '[]' },
      // scheduled invoice for l5 on an OPEN statement — swaps
      { id: 'i-l5', scheduled_service_id: 'l5', status: 'scheduled', title: 'Lawn + Pest Control Service', service_type: 'Pest Control Service', payer_statement_id: 'ps-open', updated_at: 'orig', line_items: null },
      // draft for an untouched visit — untouched
      { id: 'i-l4', scheduled_service_id: 'l4', status: 'draft', title: 'General Pest Control', service_type: 'General Pest Control', payer_statement_id: null, updated_at: 'orig', line_items: '[]' },
    ],
    payer_statements: [
      { id: 'ps-closed', status: 'issued' },
      { id: 'ps-open', status: 'open' },
    ],
    system_settings: [],
  };
}

const byId = (db, id) => db.scheduled_services.find((r) => r.id === id);
const rem = (db, id) => db.appointment_reminders.find((r) => r.id === id);
const sb = (db, id) => db.self_booked_appointments.find((r) => r.id === id);
const inv = (db, id) => db.invoices.find((r) => r.id === id);
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

  test('fans the relabel out to self-booking snapshots (exact-or-qualified) and records every linked visit', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(sb(db, 'sb-1').service_type).toBe('Quarterly Pest Control Service (Quarterly)');
    expect(sb(db, 'sb-4').service_type).toBe('Quarterly Pest Control'); // only a terminal visit links it
    expect(sb(db, 'sb-5').service_type).toBe('Owner Custom Booking Label'); // label ≠ the visit's stale name

    const state = readState(db);
    // sb-1 is linked from u1 (Quarterly Pest Control → …) and l1 (Pest
    // Control → …); only the u1 pass matched its label.
    expect(state.selfBookings).toEqual([
      { id: 'sb-1', from: 'Quarterly Pest Control', to: 'Quarterly Pest Control Service', visit_ids: ['u1'] },
    ]);
  });

  test('fans the relabel out to draft/scheduled invoices: title, service_type, line items; skips sent + frozen-statement invoices', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    const iu1 = inv(db, 'i-u1');
    expect(iu1.title).toBe('Quarterly Pest Control Service — first visit');
    expect(iu1.service_type).toBe('Quarterly Pest Control Service');
    expect(JSON.parse(iu1.line_items)).toEqual([
      { description: 'Quarterly Pest Control Service', category: 'Quarterly Pest Control Service', amount: 100 },
      { description: 'Fuel surcharge', category: 'fee', amount: 5 },
    ]);
    expect(iu1.updated_at).toBe('NOW');
    expect(inv(db, 'i-u1-sent').service_type).toBe('Quarterly Pest Control'); // sent = history
    expect(inv(db, 'i-l1-frozen').service_type).toBe('Pest Control'); // frozen statement
    expect(inv(db, 'i-l5').title).toBe('Lawn + Monthly Pest Control Service');
    expect(inv(db, 'i-l5').service_type).toBe('Monthly Pest Control Service');
    expect(inv(db, 'i-l4').service_type).toBe('General Pest Control'); // untouched visit

    const state = readState(db);
    expect(state.invoices.map((r) => r.id).sort()).toEqual(['i-l5', 'i-u1']);
    expect(state.invoices.find((r) => r.id === 'i-u1')).toEqual({
      id: 'i-u1',
      changed: { title: true, service_type: true, items: [{ i: 0, description: true, category: true }] },
      from: 'Quarterly Pest Control',
      to: 'Quarterly Pest Control Service',
      visit_id: 'u1',
    });
  });

  test('skips a snapshot fanout whose table is missing, still relabels visits', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db, { missingTables: ['appointment_reminders', 'self_booked_appointments', 'invoices'] }));
    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control Service');
    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control');
    expect(sb(db, 'sb-1').service_type).toBe('Quarterly Pest Control (Quarterly)');
    expect(inv(db, 'i-u1').service_type).toBe('Quarterly Pest Control');
    const state = readState(db);
    expect(state.reminders).toEqual([]);
    expect(state.selfBookings).toEqual([]);
    expect(state.invoices).toEqual([]);
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

  test('reverses self-booking and invoice snapshots only while their component visits are open, unedited, and not frozen', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    // Clean reversal path first: everything still open + untouched.
    await migration.down(knex);
    expect(sb(db, 'sb-1').service_type).toBe('Quarterly Pest Control (Quarterly)');
    const iu1 = inv(db, 'i-u1');
    expect(iu1.title).toBe('Quarterly Pest Control — first visit');
    expect(iu1.service_type).toBe('Quarterly Pest Control');
    expect(JSON.parse(iu1.line_items)[0]).toEqual({ description: 'Quarterly Pest Control', category: 'Quarterly Pest Control', amount: 100 });
    expect(inv(db, 'i-l5').title).toBe('Lawn + Pest Control Service');
    expect(inv(db, 'i-l5').service_type).toBe('Pest Control Service');
  });

  test('keeps self-booking and invoice snapshots whose component visit completed, whose invoice was edited, or whose statement froze since up()', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    byId(db, 'u1').status = 'completed'; // sb-1 + i-u1 keep the new label
    inv(db, 'i-l5').updated_at = 'edited-since'; // CAS mismatch → kept
    db.payer_statements.find((p) => p.id === 'ps-open').status = 'issued'; // froze since → kept anyway

    await migration.down(knex);

    expect(sb(db, 'sb-1').service_type).toBe('Quarterly Pest Control Service (Quarterly)');
    expect(inv(db, 'i-u1').service_type).toBe('Quarterly Pest Control Service');
    expect(inv(db, 'i-u1').title).toBe('Quarterly Pest Control Service — first visit');
    expect(inv(db, 'i-l5').service_type).toBe('Monthly Pest Control Service');
    expect(inv(db, 'i-l5').title).toBe('Lawn + Monthly Pest Control Service');
  });

  test('down is a no-op without a state row', async () => {
    const db = seedDb();
    await expect(migration.down(fakeKnex(db))).resolves.toBeUndefined();
    expect(byId(db, 'u1').service_type).toBe('Quarterly Pest Control');
    expect(rem(db, 'r-u1').service_type).toBe('Quarterly Pest Control');
  });
});
