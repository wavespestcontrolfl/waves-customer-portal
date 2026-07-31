/**
 * 20260730160000 roach catalog cleanup (owner directive 2026-07-30, follow-up
 * to #3078): rename cockroach_control to the estimate's customer-facing name,
 * archive the two never-booked pest_initial_*_knockdown rows, and backfill
 * open-visit / completion-profile label snapshots. Ownership is RECORDED in a
 * system_settings state row (codex #3108 r1) — down() restores only what
 * up() proved it changed, so pre-migration admin renames/archives and
 * pre-hidden flags survive a rollback, and history keeps its labels.
 */
const migration = require('../models/migrations/20260730160000_roach_catalog_rename_archive');

const OLD_NAME = 'Cockroach Control Service';
const NEW_NAME = 'Cockroach Treatment';
const STATE_KEY = 'migration.20260730160000.state';
const LIVE = { is_active: true, is_archived: false, booking_enabled: true, customer_visible: true };
const ARCHIVED = { is_active: false, is_archived: true, booking_enabled: false, customer_visible: false };

function seedDb() {
  return {
    services: [
      { id: 'svc-roach', service_key: 'cockroach_control', name: OLD_NAME, short_name: 'Cockroach Control', ...LIVE, updated_at: 'orig' },
      { id: 'svc-palmetto', service_key: 'pest_initial_palmetto_knockdown', name: 'Initial Native Roach Knockdown Service', short_name: null, ...LIVE, updated_at: 'orig' },
      { id: 'svc-german', service_key: 'pest_initial_german_knockdown', name: 'Initial German Roach Knockdown Service', short_name: null, ...LIVE, updated_at: 'orig' },
      { id: 'svc-general', service_key: 'general_pest', name: 'General Pest Control', short_name: 'General Pest', ...LIVE, updated_at: 'orig' },
    ],
    scheduled_services: [
      // v-open-2 has a legacy NULL service_id — the exact-label fallback path.
      { id: 'v-open-1', service_type: OLD_NAME, status: 'pending', service_id: 'svc-roach', self_booking_id: 'sb-1' },
      { id: 'v-open-2', service_type: OLD_NAME, status: 'confirmed', service_id: null },
      { id: 'v-done', service_type: OLD_NAME, status: 'completed', service_id: 'svc-roach' },
      { id: 'v-other', service_type: 'Lawn Care Service', status: 'pending', service_id: 'svc-general' },
      // Open non-roach visit carrying the roach ADD-ON (codex r5).
      { id: 'v-parent', service_type: 'Quarterly Pest Control Service', status: 'confirmed', service_id: 'svc-general' },
    ],
    self_booked_appointments: [
      { id: 'sb-1', service_type: OLD_NAME, status: 'confirmed' },
    ],
    payer_statements: [
      { id: 'stmt-frozen', status: 'finalized' },
      { id: 'stmt-open', status: 'open' },
    ],
    scheduled_service_addons: [
      { id: 'add-open', scheduled_service_id: 'v-parent', service_id: 'svc-roach', service_name: OLD_NAME },
      // Add-on on a completed visit — history, never relabeled.
      { id: 'add-done', scheduled_service_id: 'v-done', service_id: 'svc-roach', service_name: OLD_NAME },
    ],
    appointment_reminders: [
      { id: 'rem-1', scheduled_service_id: 'v-open-1', service_type: OLD_NAME, customer_id: 'cust-1', appointment_time: 'T1', updated_at: 'orig' },
      // Real second-registration shape (codex r5): the cockroach visit's own
      // row is suppressed with a PRISTINE label; the merged label lives on
      // the sibling OWNER row linked to the earlier (lawn) visit.
      { id: 'rem-suppressed', scheduled_service_id: 'v-open-2', service_type: OLD_NAME, suppressed_by_sibling: true, customer_id: 'cust-2', appointment_time: 'T2', updated_at: 'orig' },
      { id: 'rem-owner', scheduled_service_id: 'v-other', service_type: `Lawn Care Service & ${OLD_NAME}`, customer_id: 'cust-2', appointment_time: 'T2', updated_at: 'orig' },
      // Reminder on the add-on parent — Oxford 3+ label with the old name
      // EMBEDDED mid-list, plus a component that itself contains " & "
      // (codex r6: splitting only on " & " left the old name inside a
      // larger component).
      { id: 'rem-parent', scheduled_service_id: 'v-parent', service_type: `Quarterly Pest Control Service, ${OLD_NAME}, and Wasp & Hornet Control`, customer_id: 'cust-4', appointment_time: 'T4', updated_at: 'orig' },
      // Mixed merged form "A, B & C" on the shared slot — reached via the
      // sibling sweep.
      { id: 'rem-owner-mixed', scheduled_service_id: 'v-other', service_type: `Bed Bug Treatment, ${OLD_NAME} & Flea Treatment`, customer_id: 'cust-2', appointment_time: 'T2', updated_at: 'orig' },
      { id: 'rem-unrelated', scheduled_service_id: 'v-other', service_type: 'Lawn Care Service', customer_id: 'cust-3', appointment_time: 'T3', updated_at: 'orig' },
    ],
    service_completion_profiles: [
      { service_key: 'cockroach_control', service_name_snapshot: OLD_NAME },
    ],
    invoices: [
      {
        id: 'inv-draft',
        scheduled_service_id: 'v-open-1',
        status: 'draft',
        title: OLD_NAME,
        service_type: OLD_NAME,
        line_items: JSON.stringify([
          { description: OLD_NAME, category: OLD_NAME, quantity: 1, unit_price: 350, amount: 350 },
        ]),
      },
      {
        id: 'inv-sent',
        scheduled_service_id: 'v-open-2',
        status: 'sent',
        title: OLD_NAME,
        line_items: JSON.stringify([{ description: OLD_NAME, category: OLD_NAME, amount: 350 }]),
      },
      // Draft on the ADD-ON parent: only the add-on line matches.
      {
        id: 'inv-parent',
        scheduled_service_id: 'v-parent',
        status: 'draft',
        title: 'Quarterly Pest Control Service',
        service_type: 'Quarterly Pest Control Service',
        line_items: JSON.stringify([
          { description: 'Quarterly Pest Control Service', category: 'General Pest', amount: 150 },
          { description: OLD_NAME, category: OLD_NAME, amount: 350 },
        ]),
      },
    ],
    system_settings: [],
  };
}

function fakeKnex(db, { missingTables = [] } = {}) {
  const knex = (table) => {
    const filters = [];
    const inClauses = [];
    const notInClauses = [];
    const rowsNow = () => db[table] || [];
    const rowMatch = (r) => (
      inClauses.every((c) => c.vals.includes(r[c.col]))
      && notInClauses.every((c) => !c.vals.includes(r[c.col]))
      && filters.every((cond) => Object.entries(cond).every(([k, v]) => r[k] === v))
    );
    // Real knex accepts a query builder as the whereIn value (subquery) —
    // resolve any thenable value lists before filtering, extracting the
    // single selected column from row objects.
    const resolveSubqueries = async () => {
      for (const c of inClauses) {
        if (c.vals && typeof c.vals.then === 'function') {
          c.vals = (await c.vals).map((v) => (v && typeof v === 'object' ? Object.values(v)[0] : v));
        }
      }
    };
    const q = {
      where(cond) { filters.push(cond); return q; },
      whereIn(col, vals) { inClauses.push({ col, vals }); return q; },
      whereNotIn(col, vals) { notInClauses.push({ col, vals }); return q; },
      whereNull(col) { filters.push({ [col]: null }); return q; },
      whereNot(col, val) { notInClauses.push({ col, vals: [val] }); return q; },
      forUpdate() { return q; },
      async select(...cols) {
        await resolveSubqueries();
        return rowsNow().filter(rowMatch).map((r) => {
          if (!cols.length) return { ...r };
          const out = {};
          cols.forEach((c) => { out[c] = r[c]; });
          return out;
        });
      },
      first: async () => {
        await resolveSubqueries();
        const hit = rowsNow().find(rowMatch);
        return hit ? { ...hit } : undefined;
      },
      update: async (patch, returning) => {
        await resolveSubqueries();
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
      then(resolve, reject) {
        return Promise.resolve(rowsNow().filter(rowMatch).map((r) => ({ ...r }))).then(resolve, reject);
      },
    };
    return q;
  };
  knex.schema = {
    hasTable: async (t) => !missingTables.includes(t) && t in db,
  };
  knex.fn = { now: () => 'NOW' };
  return knex;
}

const byKey = (db, key) => db.services.find((r) => r.service_key === key);
const invoiceById = (db, id) => db.invoices.find((r) => r.id === id);
const visit = (db, id) => db.scheduled_services.find((r) => r.id === id);
const stateRow = (db) => db.system_settings.find((r) => r.key === STATE_KEY);

describe('20260730160000 roach catalog rename + archive', () => {
  test('up() renames, archives, backfills open snapshots, and records ownership', async () => {
    const db = seedDb();
    await migration.up(fakeKnex(db));

    expect(byKey(db, 'cockroach_control')).toMatchObject({ name: NEW_NAME, short_name: NEW_NAME, updated_at: 'NOW' });
    for (const key of ['pest_initial_palmetto_knockdown', 'pest_initial_german_knockdown']) {
      expect(byKey(db, key)).toMatchObject(ARCHIVED);
      // Archive never renames — descriptions/history keep the original label.
      expect(byKey(db, key).name).toMatch(/Knockdown Service$/);
    }
    expect(byKey(db, 'general_pest')).toMatchObject({ name: 'General Pest Control', ...LIVE, updated_at: 'orig' });

    // Open visits renamed; completed history and other services untouched.
    expect(visit(db, 'v-open-1').service_type).toBe(NEW_NAME);
    expect(visit(db, 'v-open-2').service_type).toBe(NEW_NAME);
    expect(visit(db, 'v-done').service_type).toBe(OLD_NAME);
    expect(visit(db, 'v-other').service_type).toBe('Lawn Care Service');
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(NEW_NAME);

    const state = JSON.parse(stateRow(db).value);
    expect(state.renamedFields.sort()).toEqual(['name', 'short_name']);
    expect(Object.keys(state.archived).sort()).toEqual(['pest_initial_german_knockdown', 'pest_initial_palmetto_knockdown']);
    expect(state.archived.pest_initial_palmetto_knockdown).toEqual({ is_active: true, is_archived: false, booking_enabled: true, customer_visible: true });
    expect(state.backfilledVisitIds.sort()).toEqual(['v-open-1', 'v-open-2']);
    expect(state.profileSnapshotUpdated).toBe(true);
  });

  test('up() drift guards: pre-renamed field and pre-archived row are neither touched nor claimed', async () => {
    const db = seedDb();
    // Admin already renamed the service themselves and archived one row
    // before the deploy; the other row was live but admin-hidden.
    byKey(db, 'cockroach_control').name = NEW_NAME;
    Object.assign(byKey(db, 'pest_initial_german_knockdown'), ARCHIVED);
    byKey(db, 'pest_initial_palmetto_knockdown').booking_enabled = false;

    await migration.up(fakeKnex(db));

    const state = JSON.parse(stateRow(db).value);
    // Only short_name was actually changed — name is not claimed.
    expect(state.renamedFields).toEqual(['short_name']);
    // The pre-archived row is not claimed; the hidden flag is recorded as-is.
    expect(Object.keys(state.archived)).toEqual(['pest_initial_palmetto_knockdown']);
    expect(state.archived.pest_initial_palmetto_knockdown).toEqual({ is_active: true, is_archived: false, booking_enabled: false, customer_visible: true });
    expect(byKey(db, 'pest_initial_german_knockdown').updated_at).toBe('orig');
  });

  test('down() restores exactly the recorded state and deletes the record', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // A visit booked AFTER the migration carries the new label organically —
    // it is not in the recorded ids and must keep it through rollback.
    db.scheduled_services.push({ id: 'v-post', service_type: NEW_NAME, status: 'pending' });

    await migration.down(knex);

    expect(byKey(db, 'cockroach_control')).toMatchObject({ name: OLD_NAME, short_name: 'Cockroach Control' });
    for (const key of ['pest_initial_palmetto_knockdown', 'pest_initial_german_knockdown']) {
      expect(byKey(db, key)).toMatchObject(LIVE);
    }
    expect(visit(db, 'v-open-1').service_type).toBe(OLD_NAME);
    expect(visit(db, 'v-open-2').service_type).toBe(OLD_NAME);
    expect(visit(db, 'v-post').service_type).toBe(NEW_NAME);
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(OLD_NAME);
    expect(stateRow(db)).toBeUndefined();
  });

  test('down() restores recorded prior flags, not blanket true (codex #3108 r1)', async () => {
    const db = seedDb();
    // Live but admin-hidden before the migration: booking_enabled=false.
    byKey(db, 'pest_initial_palmetto_knockdown').booking_enabled = false;
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);

    expect(byKey(db, 'pest_initial_palmetto_knockdown')).toMatchObject({
      is_active: true,
      is_archived: false,
      booking_enabled: false, // the recorded prior value — never blanket-restored
      customer_visible: true,
    });
  });

  test('down() leaves pre-archived rows and pre-renamed fields alone (codex #3108 r1)', async () => {
    const db = seedDb();
    // Admin renamed to the new name AND archived a row BEFORE up() ran.
    byKey(db, 'cockroach_control').name = NEW_NAME;
    Object.assign(byKey(db, 'pest_initial_german_knockdown'), ARCHIVED);
    const knex = fakeKnex(db);
    await migration.up(knex);
    await migration.down(knex);

    // The admin's own rename is NOT reverted to the legacy value…
    expect(byKey(db, 'cockroach_control').name).toBe(NEW_NAME);
    // …while the field up() did change rolls back.
    expect(byKey(db, 'cockroach_control').short_name).toBe('Cockroach Control');
    // The admin-archived row stays archived — up() never claimed it.
    expect(byKey(db, 'pest_initial_german_knockdown')).toMatchObject(ARCHIVED);
    expect(byKey(db, 'pest_initial_palmetto_knockdown')).toMatchObject(LIVE);
  });

  test('down() leaves post-migration admin edits alone', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // After the migration ran, the admin renamed again and re-activated a row.
    byKey(db, 'cockroach_control').name = 'Roach Rescue';
    byKey(db, 'pest_initial_palmetto_knockdown').is_active = true;

    await migration.down(knex);

    expect(byKey(db, 'cockroach_control').name).toBe('Roach Rescue');
    expect(byKey(db, 'cockroach_control').short_name).toBe('Cockroach Control');
    // Not in the archived state down() owns — left exactly as the admin set it.
    expect(byKey(db, 'pest_initial_palmetto_knockdown')).toMatchObject({ is_active: true, is_archived: true });
    expect(byKey(db, 'pest_initial_german_knockdown')).toMatchObject(LIVE);
  });

  test('pre-minted DRAFT invoice labels backfill; sent invoices stay frozen (codex #3108 r3)', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);

    const draft = invoiceById(db, 'inv-draft');
    expect(draft.title).toBe(NEW_NAME);
    // service_type is its own rendered snapshot (pay/receipt, emails, PDFs).
    expect(draft.service_type).toBe(NEW_NAME);
    const items = JSON.parse(draft.line_items);
    expect(items[0].description).toBe(NEW_NAME);
    expect(items[0].category).toBe(NEW_NAME);
    // Amounts are untouched.
    expect(items[0].unit_price).toBe(350);
    expect(items[0].amount).toBe(350);
    // The sent invoice already reached the customer — frozen.
    expect(invoiceById(db, 'inv-sent').title).toBe(OLD_NAME);

    const state = JSON.parse(stateRow(db).value);
    expect(Object.keys(state.relabeledInvoices).sort()).toEqual(['inv-draft', 'inv-parent']);
    expect(state.relabeledInvoices['inv-draft']).toMatchObject({ title: true, service_type: true });
    // The parent draft claimed only its matching add-on line.
    expect(state.relabeledInvoices['inv-parent']).toMatchObject({ title: false, service_type: false });

    // Reminders: directly-linked rows, the same-slot sibling OWNER row
    // holding the merged label, and the add-on parent's merged row all
    // relabel; unrelated rows untouched.
    const rem = (id) => db.appointment_reminders.find((r) => r.id === id);
    expect(rem('rem-1').service_type).toBe(NEW_NAME);
    expect(rem('rem-suppressed').service_type).toBe(NEW_NAME);
    expect(rem('rem-owner').service_type).toBe(`Lawn Care Service & ${NEW_NAME}`);
    // Oxford 3+ form: the embedded component swaps; "Wasp & Hornet Control"
    // splits on its own '&' but rejoins byte-identical.
    expect(rem('rem-parent').service_type).toBe(`Quarterly Pest Control Service, ${NEW_NAME}, and Wasp & Hornet Control`);
    // Mixed "A, B & C" merged form via the sibling sweep.
    expect(rem('rem-owner-mixed').service_type).toBe(`Bed Bug Treatment, ${NEW_NAME} & Flea Treatment`);
    expect(rem('rem-unrelated').service_type).toBe('Lawn Care Service');

    // Self-booking snapshot (exposed by /api/booking/status) relabels with
    // its linked open visit.
    expect(db.self_booked_appointments.find((s) => s.id === 'sb-1').service_type).toBe(NEW_NAME);
    expect(state.relabeledSelfBookingIds).toEqual(['sb-1']);

    // Add-on snapshots: open parent relabels, completed parent is history.
    const addon = (id) => db.scheduled_service_addons.find((a) => a.id === id);
    expect(addon('add-open').service_name).toBe(NEW_NAME);
    expect(addon('add-done').service_name).toBe(OLD_NAME);
    expect(state.relabeledAddonIds).toEqual(['add-open']);
    expect(state.addonParentVisitIds).toEqual(['v-parent']);

    // The add-on PARENT's draft invoice relabels its matching add-on line
    // only — the primary line and title stay the parent's own.
    const parentInv = invoiceById(db, 'inv-parent');
    expect(parentInv.title).toBe('Quarterly Pest Control Service');
    const parentItems = JSON.parse(parentInv.line_items);
    expect(parentItems[0].description).toBe('Quarterly Pest Control Service');
    expect(parentItems[1].description).toBe(NEW_NAME);
    expect(parentItems[1].amount).toBe(350);

    await migration.down(knex);
    const reverted = invoiceById(db, 'inv-draft');
    expect(reverted.title).toBe(OLD_NAME);
    expect(reverted.service_type).toBe(OLD_NAME);
    expect(JSON.parse(reverted.line_items)[0].description).toBe(OLD_NAME);
    // Reminders and add-ons restore to their recorded prior values.
    const remAfter = (id) => db.appointment_reminders.find((r) => r.id === id);
    expect(remAfter('rem-1').service_type).toBe(OLD_NAME);
    expect(remAfter('rem-owner').service_type).toBe(`Lawn Care Service & ${OLD_NAME}`);
    expect(remAfter('rem-parent').service_type).toBe(`Quarterly Pest Control Service, ${OLD_NAME}, and Wasp & Hornet Control`);
    expect(remAfter('rem-owner-mixed').service_type).toBe(`Bed Bug Treatment, ${OLD_NAME} & Flea Treatment`);
    expect(db.scheduled_service_addons.find((a) => a.id === 'add-open').service_name).toBe(OLD_NAME);
    expect(db.self_booked_appointments.find((s) => s.id === 'sb-1').service_type).toBe(OLD_NAME);
  });

  test('a pre-relabeled invoice field is never claimed, so rollback leaves it (codex #3108 r4)', async () => {
    const db = seedDb();
    // The draft's title already carried the new name before up() ran.
    invoiceById(db, 'inv-draft').title = NEW_NAME;
    const knex = fakeKnex(db);
    await migration.up(knex);

    const state = JSON.parse(stateRow(db).value);
    expect(state.relabeledInvoices['inv-draft']).toMatchObject({ title: false, service_type: true });

    await migration.down(knex);
    const inv = invoiceById(db, 'inv-draft');
    // The unclaimed title keeps the new name; the claimed fields revert.
    expect(inv.title).toBe(NEW_NAME);
    expect(inv.service_type).toBe(OLD_NAME);
    expect(JSON.parse(inv.line_items)[0].description).toBe(OLD_NAME);
  });

  test('invoice rollback is skipped when the linked visit completed after up() (codex #3108 r4)', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // The visit completes via the backfill-completion lane; its invoice
    // deliberately stays a draft for operator review.
    visit(db, 'v-open-1').status = 'completed';

    await migration.down(knex);

    // The completed visit kept the new label — its draft invoice must agree.
    expect(visit(db, 'v-open-1').service_type).toBe(NEW_NAME);
    expect(invoiceById(db, 'inv-draft').title).toBe(NEW_NAME);
    expect(invoiceById(db, 'inv-draft').service_type).toBe(NEW_NAME);
  });

  test('a different catalog row sharing the legacy label is not swept (codex #3108 r4)', async () => {
    const db = seedDb();
    db.services.push({ id: 'svc-clone', service_key: 'roach_clone', name: OLD_NAME, short_name: null, ...LIVE, updated_at: 'orig' });
    db.scheduled_services.push({ id: 'v-clone', service_type: OLD_NAME, status: 'pending', service_id: 'svc-clone' });

    await migration.up(fakeKnex(db));

    // Linked to a DIFFERENT row — its own catalog entry did not rename.
    expect(visit(db, 'v-clone').service_type).toBe(OLD_NAME);
    const state = JSON.parse(stateRow(db).value);
    expect(state.backfilledVisitIds).not.toContain('v-clone');
    // The cockroach_control-linked and legacy-NULL visits still backfill.
    expect(state.backfilledVisitIds.sort()).toEqual(['v-open-1', 'v-open-2']);
  });

  test('rescheduled visits are superseded history — never relabeled (local audit P1)', async () => {
    const db = seedDb();
    db.scheduled_services.push({ id: 'v-resched', service_type: OLD_NAME, status: 'rescheduled' });

    await migration.up(fakeKnex(db));

    expect(visit(db, 'v-resched').service_type).toBe(OLD_NAME);
    const state = JSON.parse(stateRow(db).value);
    expect(state.backfilledVisitIds).not.toContain('v-resched');
  });

  test('an admin-edited draft title is not relabeled; an invoice sent after up() keeps the new label through rollback', async () => {
    const db = seedDb();
    invoiceById(db, 'inv-draft').title = 'Kitchen Roach Job — Unit 4';
    const knex = fakeKnex(db);
    await migration.up(knex);

    // Exact-match only: the custom title stays, the matching line items swap.
    const draft = invoiceById(db, 'inv-draft');
    expect(draft.title).toBe('Kitchen Roach Job — Unit 4');
    expect(JSON.parse(draft.line_items)[0].description).toBe(NEW_NAME);

    // The draft goes out to the customer before a rollback — history now.
    draft.status = 'sent';
    await migration.down(knex);
    expect(JSON.parse(invoiceById(db, 'inv-draft').line_items)[0].description).toBe(NEW_NAME);
  });

  test('down() leaves a visit that completed after up() alone (codex #3108 r2)', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    // The visit completed between up() and the rollback — its label is
    // history now (completion snapshots copied it) and must not be rewritten.
    visit(db, 'v-open-1').status = 'completed';

    await migration.down(knex);

    expect(visit(db, 'v-open-1').service_type).toBe(NEW_NAME);
    expect(visit(db, 'v-open-2').service_type).toBe(OLD_NAME);
  });

  test('backfills are skipped when an admin renamed the catalog row to a custom value (codex #3108 r2)', async () => {
    const db = seedDb();
    byKey(db, 'cockroach_control').name = 'Adam Roach Special';

    await migration.up(fakeKnex(db));

    // Admin's label owns invoices/reports too — no hardcoded backfill.
    expect(visit(db, 'v-open-1').service_type).toBe(OLD_NAME);
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(OLD_NAME);
    const state = JSON.parse(stateRow(db).value);
    expect(state.backfilledVisitIds).toEqual([]);
    expect(state.profileSnapshotUpdated).toBe(false);
    // The archive half still applies.
    expect(byKey(db, 'pest_initial_palmetto_knockdown')).toMatchObject(ARCHIVED);
  });

  test('backfills still run when the admin pre-renamed to exactly the intended name', async () => {
    const db = seedDb();
    byKey(db, 'cockroach_control').name = NEW_NAME;

    await migration.up(fakeKnex(db));

    expect(visit(db, 'v-open-1').service_type).toBe(NEW_NAME);
    expect(db.service_completion_profiles[0].service_name_snapshot).toBe(NEW_NAME);
  });

  test('NULL catalog flags are recorded and restored verbatim, never coerced (codex #3108 r2)', async () => {
    const db = seedDb();
    // Drifted env: live row with NULL visibility flags.
    Object.assign(byKey(db, 'pest_initial_palmetto_knockdown'), { is_archived: null, booking_enabled: null, customer_visible: null });
    const knex = fakeKnex(db);
    await migration.up(knex);

    const state = JSON.parse(stateRow(db).value);
    expect(state.archived.pest_initial_palmetto_knockdown).toEqual({
      is_active: true,
      is_archived: null,
      booking_enabled: null,
      customer_visible: null,
    });
    expect(byKey(db, 'pest_initial_palmetto_knockdown')).toMatchObject(ARCHIVED);

    await migration.down(knex);
    // NULLs come back as NULLs — is_archived: false would newly match
    // catalog queries requiring it, customer_visible: false would hide it.
    expect(byKey(db, 'pest_initial_palmetto_knockdown')).toMatchObject({
      is_active: true,
      is_archived: null,
      booking_enabled: null,
      customer_visible: null,
    });
  });

  test('a NULL is_active row is not archived (not affirmatively live)', async () => {
    const db = seedDb();
    byKey(db, 'pest_initial_german_knockdown').is_active = null;

    await migration.up(fakeKnex(db));

    expect(byKey(db, 'pest_initial_german_knockdown').is_archived).toBe(false);
    const state = JSON.parse(stateRow(db).value);
    expect(Object.keys(state.archived)).toEqual(['pest_initial_palmetto_knockdown']);
  });

  test('drafts accrued to a frozen payer statement stay untouched both ways (codex #3108 r8)', async () => {
    const db = seedDb();
    // Two drafts on the backfilled visit: one accrued to a FINALIZED
    // statement (issued document — its lines render live from
    // invoices.service_type), one accrued to a still-open statement.
    invoiceById(db, 'inv-draft').payer_statement_id = 'stmt-frozen';
    db.invoices.push({
      id: 'inv-open-stmt',
      scheduled_service_id: 'v-open-1',
      status: 'draft',
      title: OLD_NAME,
      service_type: OLD_NAME,
      payer_statement_id: 'stmt-open',
      line_items: JSON.stringify([{ description: OLD_NAME, category: OLD_NAME, amount: 350 }]),
    });
    const knex = fakeKnex(db);
    await migration.up(knex);

    expect(invoiceById(db, 'inv-draft').title).toBe(OLD_NAME);
    expect(invoiceById(db, 'inv-open-stmt').title).toBe(NEW_NAME);
    const state = JSON.parse(stateRow(db).value);
    expect(Object.keys(state.relabeledInvoices)).not.toContain('inv-draft');

    // An invoice that accrues to a finalized statement AFTER up() is part
    // of an issued document by rollback time — down() leaves it.
    invoiceById(db, 'inv-open-stmt').payer_statement_id = 'stmt-frozen';
    await migration.down(knex);
    expect(invoiceById(db, 'inv-open-stmt').title).toBe(NEW_NAME);
  });

  test('addon rollback is skipped when the parent completed after up() (codex #3108 r5)', async () => {
    const db = seedDb();
    const knex = fakeKnex(db);
    await migration.up(knex);
    visit(db, 'v-parent').status = 'completed';

    await migration.down(knex);

    // The completed parent's add-on snapshot stays with the visit's label.
    expect(db.scheduled_service_addons.find((a) => a.id === 'add-open').service_name).toBe(NEW_NAME);
    expect(invoiceById(db, 'inv-parent').title).toBe('Quarterly Pest Control Service');
    expect(JSON.parse(invoiceById(db, 'inv-parent').line_items)[1].description).toBe(NEW_NAME);
  });

  test('down() with no ownership record restores nothing', async () => {
    const db = seedDb();
    // Simulate the archived-looking state WITHOUT up() having recorded it.
    Object.assign(byKey(db, 'pest_initial_german_knockdown'), ARCHIVED);
    byKey(db, 'cockroach_control').name = NEW_NAME;

    await migration.down(fakeKnex(db));

    expect(byKey(db, 'cockroach_control').name).toBe(NEW_NAME);
    expect(byKey(db, 'pest_initial_german_knockdown')).toMatchObject(ARCHIVED);
  });

  test('up() and down() no-op without the services table; up() tolerates a missing system_settings table', async () => {
    const db = seedDb();
    const noServices = fakeKnex(db, { missingTables: ['services'] });
    await migration.up(noServices);
    await migration.down(noServices);
    expect(byKey(db, 'cockroach_control').name).toBe(OLD_NAME);

    // Without system_settings the rename/archive still applies; down() then
    // has no record and correctly restores nothing.
    const db2 = seedDb();
    delete db2.system_settings;
    const knex2 = fakeKnex(db2);
    await migration.up(knex2);
    expect(byKey(db2, 'cockroach_control').name).toBe(NEW_NAME);
    await migration.down(knex2);
    expect(byKey(db2, 'cockroach_control').name).toBe(NEW_NAME);
  });
});
