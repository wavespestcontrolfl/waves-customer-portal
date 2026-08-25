/**
 * 20260825000010 service name suffix renames (owner directive 2026-08-25):
 * every catalog service name ends in " Service"; drill-and-foam becomes
 * "Termite Foam Service" / "Recurring Termite Foam Service".
 *
 * Follows the 20260730160000 fanout pattern: a row is renamed ONLY while it
 * still carries the shipped name; every dependent label snapshot (open
 * visits, self-bookings, add-ons under open parents, draft/scheduled
 * invoices, reminders, completion-profile snapshots, protocol aliases) is
 * relabeled with ownership recorded in system_settings, and down() reverses
 * exactly what up() recorded. Harness mirrors
 * roach-catalog-rename-archive.test.js.
 */
const migration = require('../models/migrations/20260825000010_service_name_suffix_renames');

const STATE_KEY = 'migration.20260825000010.state';
const ALIAS_MARKER = 'alias added by migration:20260825000010 (catalog rename)';
const ROACH_OLD = 'Cockroach Treatment';
const ROACH_NEW = 'Cockroach Treatment Service';
const FOAM_OLD = 'Drill-and-Foam Termite';
const FOAM_NEW = 'Termite Foam Service';

function seedDb() {
  return {
    services: [
      { id: 'svc-roach', service_key: 'cockroach_control', name: ROACH_OLD, updated_at: 'orig' },
      { id: 'svc-foam', service_key: 'foam_drill', name: FOAM_OLD, updated_at: 'orig' },
      { id: 'svc-foamr', service_key: 'foam_recurring', name: 'Recurring Foam Treatment', updated_at: 'orig' },
      // Admin-edited: shipped name gone — rename AND its fanout must skip.
      { id: 'svc-guar', service_key: 'rodent_guarantee', name: 'Rodent Guarantee Plan (Adam)', updated_at: 'orig' },
      { id: 'svc-general', service_key: 'general_pest', name: 'General Pest Control', updated_at: 'orig' },
      { id: 'svc-bb', service_key: 'bed_bug_treatment', name: 'Bed Bug Treatment', updated_at: 'orig' },
      // Renamed name that CONTAINS a list delimiter — the reminder relabel
      // must handle it whole (codex pre-push P1, PR2 round 1).
      { id: 'svc-lts', service_key: 'lawn_tree_shrub_combo', name: 'Lawn + Tree & Shrub', updated_at: 'orig' },
    ],
    scheduled_services: [
      { id: 'v-open-1', service_type: ROACH_OLD, status: 'pending', service_id: 'svc-roach', self_booking_id: 'sb-1' },
      // Legacy NULL service_id row still carrying the exact shipped label.
      { id: 'v-open-2', service_type: ROACH_OLD, status: 'confirmed', service_id: null },
      { id: 'v-done', service_type: ROACH_OLD, status: 'completed', service_id: 'svc-roach' },
      { id: 'v-skip', service_type: ROACH_OLD, status: 'skipped', service_id: 'svc-roach' },
      // Open visit under the ADMIN-EDITED catalog row: fanout must not touch.
      { id: 'v-guar', service_type: 'Rodent Guarantee', status: 'pending', service_id: 'svc-guar' },
      // Open non-roach parent carrying the roach ADD-ON.
      { id: 'v-parent', service_type: 'Quarterly Pest Control Service', status: 'confirmed', service_id: 'svc-general' },
      // Open bed-bug visit sharing a reminder slot with the merged label
      // below — reached in the LATER bed_bug rename pass.
      { id: 'v-bb', service_type: 'Bed Bug Treatment', status: 'pending', service_id: 'svc-bb' },
      { id: 'v-lts', service_type: 'Lawn + Tree & Shrub', status: 'pending', service_id: 'svc-lts' },
    ],
    self_booked_appointments: [
      { id: 'sb-1', service_type: ROACH_OLD, status: 'confirmed' },
    ],
    scheduled_service_addons: [
      { id: 'add-open', scheduled_service_id: 'v-parent', service_id: 'svc-roach', service_name: ROACH_OLD },
      { id: 'add-done', scheduled_service_id: 'v-done', service_id: 'svc-roach', service_name: ROACH_OLD },
    ],
    payer_statements: [
      { id: 'stmt-frozen', status: 'finalized' },
    ],
    invoices: [
      {
        id: 'inv-draft',
        scheduled_service_id: 'v-open-1',
        status: 'draft',
        title: ROACH_OLD,
        service_type: ROACH_OLD,
        updated_at: 'inv-t0',
        line_items: JSON.stringify([
          { description: ROACH_OLD, category: ROACH_OLD, quantity: 1, unit_price: 350, amount: 350 },
        ]),
      },
      {
        id: 'inv-sent',
        scheduled_service_id: 'v-open-2',
        status: 'sent',
        title: ROACH_OLD,
        updated_at: 'inv-t0',
        line_items: JSON.stringify([{ description: ROACH_OLD, amount: 350 }]),
      },
      {
        id: 'inv-frozen',
        scheduled_service_id: 'v-open-2',
        status: 'draft',
        title: ROACH_OLD,
        service_type: ROACH_OLD,
        payer_statement_id: 'stmt-frozen',
        updated_at: 'inv-t0',
        line_items: JSON.stringify([{ description: ROACH_OLD, amount: 350 }]),
      },
    ],
    appointment_reminders: [
      { id: 'rem-1', scheduled_service_id: 'v-open-1', service_type: ROACH_OLD, customer_id: 'c1', appointment_time: 'T1', updated_at: 'orig' },
      // Merged label on the add-on parent's reminder.
      { id: 'rem-parent', scheduled_service_id: 'v-parent', service_type: `Quarterly Pest Control Service & ${ROACH_OLD}`, customer_id: 'c2', appointment_time: 'T2', updated_at: 'orig' },
      { id: 'rem-unrelated', scheduled_service_id: 'v-parent', service_type: 'Lawn Care Service', customer_id: 'c3', appointment_time: 'T3', updated_at: 'orig' },
      // Merged label containing TWO renamed components: rewritten once per
      // rename (cockroach pass via its own link, bed_bug pass via the
      // sibling sweep from rem-bb's slot) — down() must unwind BOTH.
      { id: 'rem-merged', scheduled_service_id: 'v-open-1', service_type: `${ROACH_OLD} & Bed Bug Treatment`, customer_id: 'c5', appointment_time: 'T5', updated_at: 'orig' },
      { id: 'rem-bb', scheduled_service_id: 'v-bb', service_type: 'Bed Bug Treatment', customer_id: 'c5', appointment_time: 'T5', updated_at: 'orig' },
      // Sole-service label that CONTAINS ' & ' — the exemplar's tokenizer
      // shattered it into non-matching tokens and never relabeled it.
      { id: 'rem-lts', scheduled_service_id: 'v-lts', service_type: 'Lawn + Tree & Shrub', customer_id: 'c6', appointment_time: 'T6', updated_at: 'orig' },
      // The same delimiter-bearing name as ONE component of a merged label
      // (shares rem-bb's slot so the bed_bug pass reaches it via siblings).
      { id: 'rem-lts-merged', scheduled_service_id: 'v-lts', service_type: 'Lawn + Tree & Shrub & Bed Bug Treatment', customer_id: 'c5', appointment_time: 'T5', updated_at: 'orig' },
    ],
    service_completion_profiles: [
      { service_key: 'cockroach_control', service_name_snapshot: ROACH_OLD },
      { service_key: 'foam_drill', service_name_snapshot: FOAM_OLD },
    ],
    protocol_template_service_types: [
      { protocol_template_id: 'pt-1', service_type: ROACH_OLD },
      // Admin-created alias already carrying the NEW name, no marker —
      // down() must never delete it.
      { protocol_template_id: 'pt-2', service_type: ROACH_NEW, notes: 'admin' },
    ],
    system_settings: [],
  };
}

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const inClauses = [];
    const notInClauses = [];
    const rawWheres = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => (
      inClauses.every((c) => c.vals.includes(r[c.col]))
      && notInClauses.every((c) => !c.vals.includes(r[c.col]))
      && filters.every((cond) => Object.entries(cond).every(([k, v]) => r[k] === v))
      && rawWheres.every((rw) => String(r.updated_at) === String(rw.bindings[0]))
    );
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, vals) { inClauses.push({ col, vals }); return q; },
      whereNotIn(col, vals) { notInClauses.push({ col, vals }); return q; },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      whereRaw(sql, bindings) {
        if (!/updated_at::text\s*=\s*\?/.test(sql)) throw new Error(`fake whereRaw: unsupported sql ${sql}`);
        rawWheres.push({ sql, bindings });
        return q;
      },
      forUpdate() { return q; },
      async select(...cols) {
        return rowsNow().filter(rowMatch).map((r) => {
          if (!cols.length) return { ...r };
          const out = {};
          cols.forEach((c) => {
            if (c && typeof c === 'object' && c.__raw) {
              if (!/updated_at::text AS updated_at_cas/i.test(c.__raw)) throw new Error(`fake raw select: unsupported ${c.__raw}`);
              out.updated_at_cas = r.updated_at == null ? null : String(r.updated_at);
              return;
            }
            out[c] = r[c];
          });
          return out;
        });
      },
      first: async () => {
        const hit = rowsNow().find(rowMatch);
        return hit ? { ...hit } : undefined;
      },
      update: async (patch, returning) => {
        const hits = rowsNow().filter(rowMatch);
        hits.forEach((r) => Object.assign(r, patch));
        if (Array.isArray(returning)) {
          return hits.map((r) => {
            const out = {};
            returning.forEach((c) => { out[c] = r[c]; });
            return out;
          });
        }
        return hits.length;
      },
      del: async () => {
        const hits = rowsNow().filter(rowMatch);
        db[table] = rowsNow().filter((r) => !hits.includes(r));
        return hits.length;
      },
      insert: async (row) => {
        (db[table] = rowsNow()).push({ ...row });
        return [1];
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
  };
  knex.fn = { now: () => 'NOW' };
  knex.raw = (sql, bindings) => {
    if (/^INSERT INTO protocol_template_service_types/i.test(String(sql).trim())) {
      const [toName, marker, fromName] = bindings;
      const aliases = db.protocol_template_service_types || [];
      const sources = aliases.filter((r) => r.service_type === fromName);
      for (const src of sources) {
        const dup = aliases.some(
          (r) => r.protocol_template_id === src.protocol_template_id && r.service_type === toName
        );
        if (!dup) {
          aliases.push({ protocol_template_id: src.protocol_template_id, service_type: toName, notes: marker });
        }
      }
      return Promise.resolve();
    }
    return { __raw: sql, bindings };
  };
  return knex;
}

const svc = (db, key) => db.services.find((r) => r.service_key === key);
const visit = (db, id) => db.scheduled_services.find((r) => r.id === id);
const invoiceById = (db, id) => db.invoices.find((r) => r.id === id);
const reminder = (db, id) => db.appointment_reminders.find((r) => r.id === id);
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);

describe('20260825000010 service name suffix renames', () => {
  test('up() renames shipped rows, skips admin-edited rows AND their fanout', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(svc(db, 'cockroach_control')).toMatchObject({ name: ROACH_NEW, updated_at: 'NOW' });
    expect(svc(db, 'foam_drill').name).toBe(FOAM_NEW);
    expect(svc(db, 'foam_recurring').name).toBe('Recurring Termite Foam Service');
    // Admin edit is owner data: no rename, and the open visit under that
    // row keeps its label (snapshots must agree with the catalog's story).
    expect(svc(db, 'rodent_guarantee').name).toBe('Rodent Guarantee Plan (Adam)');
    expect(visit(db, 'v-guar').service_type).toBe('Rodent Guarantee');

    const state = JSON.parse(stateRow(db).value);
    expect(state.renames.cockroach_control.renamed).toBe(true);
    expect(state.renames.rodent_guarantee.renamed).toBe(false);
  });

  test('up() relabels open visits (linked + legacy NULL-id), leaves terminal statuses', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(visit(db, 'v-open-1').service_type).toBe(ROACH_NEW);
    expect(visit(db, 'v-open-2').service_type).toBe(ROACH_NEW);
    expect(visit(db, 'v-done').service_type).toBe(ROACH_OLD);
    expect(visit(db, 'v-skip').service_type).toBe(ROACH_OLD);

    const state = JSON.parse(stateRow(db).value);
    expect(state.renames.cockroach_control.visitIds.sort()).toEqual(['v-open-1', 'v-open-2']);
  });

  test('up() relabels the linked self-booking, add-ons under OPEN parents only, and profile snapshots', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(db.self_booked_appointments[0].service_type).toBe(ROACH_NEW);
    expect(db.scheduled_service_addons.find((a) => a.id === 'add-open').service_name).toBe(ROACH_NEW);
    expect(db.scheduled_service_addons.find((a) => a.id === 'add-done').service_name).toBe(ROACH_OLD);
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(ROACH_NEW);
    expect(db.service_completion_profiles[1].service_name_snapshot).toBe(FOAM_NEW);
  });

  test('up() relabels draft invoice snapshots (labels only), skips sent and frozen-statement drafts', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    const draft = invoiceById(db, 'inv-draft');
    expect(draft.title).toBe(ROACH_NEW);
    expect(draft.service_type).toBe(ROACH_NEW);
    const items = JSON.parse(draft.line_items);
    expect(items[0].description).toBe(ROACH_NEW);
    expect(items[0].category).toBe(ROACH_NEW);
    expect(items[0].amount).toBe(350);
    expect(items[0].unit_price).toBe(350);

    expect(invoiceById(db, 'inv-sent').title).toBe(ROACH_OLD);
    expect(invoiceById(db, 'inv-frozen').title).toBe(ROACH_OLD);
  });

  test('up() relabels reminder components in merged labels; unrelated reminders untouched', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(reminder(db, 'rem-1').service_type).toBe(ROACH_NEW);
    expect(reminder(db, 'rem-parent').service_type).toBe(`Quarterly Pest Control Service & ${ROACH_NEW}`);
    expect(reminder(db, 'rem-unrelated').service_type).toBe('Lawn Care Service');
    // Both components of the doubly-renamed label rewritten, one per pass.
    expect(reminder(db, 'rem-merged').service_type).toBe(`${ROACH_NEW} & Bed Bug Treatment Service`);
    expect(reminder(db, 'rem-bb').service_type).toBe('Bed Bug Treatment Service');
    // A renamed name CONTAINING the ' & ' list delimiter relabels both as a
    // sole label and as one component of a merged label.
    expect(reminder(db, 'rem-lts').service_type).toBe('Lawn + Tree & Shrub Service');
    expect(reminder(db, 'rem-lts-merged').service_type).toBe('Lawn + Tree & Shrub Service & Bed Bug Treatment Service');
  });

  test('up() copies protocol aliases with the migration marker', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    const pt1 = db.protocol_template_service_types
      .filter((r) => r.protocol_template_id === 'pt-1')
      .map((r) => r.service_type).sort();
    expect(pt1).toEqual([ROACH_OLD, ROACH_NEW].sort());
    const copied = db.protocol_template_service_types
      .find((r) => r.protocol_template_id === 'pt-1' && r.service_type === ROACH_NEW);
    expect(copied.notes).toBe(ALIAS_MARKER);
  });

  test('down() reverses renames, snapshots, and ONLY marker-owned aliases', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    await migration.down(fakeKnex(db));

    expect(svc(db, 'cockroach_control').name).toBe(ROACH_OLD);
    expect(svc(db, 'foam_drill').name).toBe(FOAM_OLD);
    expect(svc(db, 'rodent_guarantee').name).toBe('Rodent Guarantee Plan (Adam)');
    expect(visit(db, 'v-open-1').service_type).toBe(ROACH_OLD);
    expect(visit(db, 'v-open-2').service_type).toBe(ROACH_OLD);
    expect(db.self_booked_appointments[0].service_type).toBe(ROACH_OLD);
    expect(db.scheduled_service_addons.find((a) => a.id === 'add-open').service_name).toBe(ROACH_OLD);
    const items = JSON.parse(invoiceById(db, 'inv-draft').line_items);
    expect(invoiceById(db, 'inv-draft').title).toBe(ROACH_OLD);
    expect(items[0].description).toBe(ROACH_OLD);
    expect(reminder(db, 'rem-parent').service_type).toBe(`Quarterly Pest Control Service & ${ROACH_OLD}`);
    // Doubly-renamed label fully unwound (reverse-order rollback: the
    // bed_bug revert must run BEFORE the cockroach revert can match).
    expect(reminder(db, 'rem-merged').service_type).toBe(`${ROACH_OLD} & Bed Bug Treatment`);
    expect(reminder(db, 'rem-lts').service_type).toBe('Lawn + Tree & Shrub');
    expect(reminder(db, 'rem-lts-merged').service_type).toBe('Lawn + Tree & Shrub & Bed Bug Treatment');
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(ROACH_OLD);

    // The marker-owned copy is gone; the admin's pre-existing new-name
    // alias (no marker) survives.
    expect(db.protocol_template_service_types.map((r) => r.service_type).sort())
      .toEqual([ROACH_OLD, ROACH_NEW].sort());
    expect(db.protocol_template_service_types.find((r) => r.service_type === ROACH_NEW).notes).toBe('admin');
    expect(stateRow(db)).toBeUndefined();
  });

  test('down() with no ownership record restores nothing', async () => {
    const db = seedDb();
    // Simulate a completed rename with no state row.
    svc(db, 'cockroach_control').name = ROACH_NEW;
    await migration.down(fakeKnex(db));
    expect(svc(db, 'cockroach_control').name).toBe(ROACH_NEW);
  });

  test('down() leaves every snapshot of a visit completed since up() under its new label', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));
    visit(db, 'v-open-1').status = 'completed';
    visit(db, 'v-parent').status = 'completed';
    await migration.down(fakeKnex(db));
    expect(visit(db, 'v-open-1').service_type).toBe(ROACH_NEW);
    // Invoice, linked self-booking, and the add-on under the completed
    // parent all agree with the completed visit, not the past.
    expect(invoiceById(db, 'inv-draft').title).toBe(ROACH_NEW);
    expect(db.self_booked_appointments[0].service_type).toBe(ROACH_NEW);
    expect(db.scheduled_service_addons.find((a) => a.id === 'add-open').service_name).toBe(ROACH_NEW);
    // The other open visit reverted normally.
    expect(visit(db, 'v-open-2').service_type).toBe(ROACH_OLD);
  });

  test('up() survives absent companion tables', async () => {
    const db = { services: seedDb().services, system_settings: [] };
    await migration.up(fakeKnex(db));
    expect(svc(db, 'foam_drill').name).toBe(FOAM_NEW);
  });
});
